/**
 * Confluence pages a teammate added to a project by link. A scan reads them by id, so a decision
 * page that never mentions the project key can still be scanned.
 *
 *   linked-pages:<KEY>  [{ id, addedAt }]   page ids only, never titles or text
 *
 * Every read is made as the signed-in person, so a page they cannot see is skipped for them.
 */
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { pageSource } from './normalize';

export const MAX_LINKED_PAGES = 10;
export const LINKED_VIA = 'a link added to this project';
const linkedKey = (projectKey) => `linked-pages:${projectKey}`;
const PAGE_ID = /^\d{1,20}$/;

/**
 * The page id in a Confluence page link: `/wiki/spaces/X/pages/123/Title`, `…/pages/edit-v2/123`,
 * `…?pageId=123`, or a bare id. Null for anything else.
 */
export function pageIdFromLink(link) {
  const text = String(link ?? '').trim();
  if (PAGE_ID.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const fromPath = url.pathname.match(/\/pages\/(?:edit-v2\/)?(\d{1,20})(?:\/|$)/);
  if (fromPath) return fromPath[1];
  const fromQuery = url.searchParams.get('pageId');
  return fromQuery && PAGE_ID.test(fromQuery) ? fromQuery : null;
}

async function storedLinks(projectKey) {
  const stored = await kvs.get(linkedKey(projectKey));
  return Array.isArray(stored) ? stored.filter((entry) => PAGE_ID.test(String(entry?.id ?? ''))) : [];
}

/**
 * Pages read by id through Confluence search as the signed-in person, keyed by id. Search is the
 * read the app's existing permission allows; a page created in the last few minutes can be
 * missing until Confluence has indexed it.
 */
async function readPages(ids) {
  const found = new Map();
  if (!ids.length) return found;
  const cql = `type = page AND id in (${ids.join(',')})`;
  const response = await api.asUser().requestConfluence(
    route`/wiki/rest/api/content/search?cql=${cql}&limit=${ids.length}&expand=version,body.atlas_doc_format,body.storage`
  );
  if (!response.ok) throw Object.assign(new Error('Confluence search failed'), { code: `HTTP_${response.status}` });
  for (const page of (await response.json())?.results ?? []) {
    if (ids.includes(String(page?.id))) found.set(String(page.id), page);
  }
  return found;
}

/**
 * Page sources for the project's linked pages that are not already in `knownIds` (bare page ids).
 * `hidden` counts linked pages this person cannot read now.
 */
export async function linkedPageSources(projectKey, knownIds = new Set()) {
  const ids = (await storedLinks(projectKey)).map(({ id }) => id).filter((id) => !knownIds.has(id));
  const found = await readPages(ids);
  return {
    pages: ids.filter((id) => found.has(id)).map((id) => pageSource(found.get(id), projectKey, LINKED_VIA)),
    hidden: ids.filter((id) => !found.has(id)).length
  };
}

/** The linked pages this person can read, for the settings list. */
export async function listLinkedPages(projectKey) {
  const { pages, hidden } = await linkedPageSources(projectKey);
  return { pages: pages.map(({ id, title, url }) => ({ id: id.replace(/^page-/, ''), title, url })), hidden };
}

/** Adds a page by link after checking the person can read it. */
export async function addLinkedPage(projectKey, link) {
  const id = pageIdFromLink(link);
  if (!id) return { ok: false, error: 'Paste the link of a Confluence page, for example https://your-site.atlassian.net/wiki/spaces/TEAM/pages/123456/Decisions.' };
  const links = await storedLinks(projectKey);
  if (links.some((entry) => entry.id === id)) return { ok: false, error: 'That page is already added to this project.' };
  if (links.length >= MAX_LINKED_PAGES) {
    return { ok: false, error: `A project can have up to ${MAX_LINKED_PAGES} pages added by link. Remove one first.` };
  }
  const page = (await readPages([id])).get(id);
  if (!page) {
    return { ok: false, error: 'No Confluence page with that link is visible to you on this site yet. A page created in the last few minutes may not be searchable yet: try again shortly.' };
  }
  await kvs.set(linkedKey(projectKey), [...links, { id, addedAt: new Date().toISOString() }]);
  return { ok: true, added: { id, title: page.title ?? 'Untitled page' } };
}

export async function removeLinkedPage(projectKey, pageId) {
  const id = String(pageId ?? '');
  if (!PAGE_ID.test(id)) return { ok: false, error: 'That page could not be found in this project\'s list.' };
  const links = await storedLinks(projectKey);
  const remaining = links.filter((entry) => entry.id !== id);
  if (remaining.length === links.length) return { ok: true };
  if (remaining.length) await kvs.set(linkedKey(projectKey), remaining);
  else await kvs.delete(linkedKey(projectKey));
  return { ok: true };
}
