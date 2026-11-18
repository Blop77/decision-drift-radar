/**
 * Reads Confluence pages directly, by page id or by space, instead of through Confluence search.
 * Search only finds a page once Confluence has indexed it, which can take an hour on a brand-new
 * site; a direct read works as soon as the page is published.
 *
 * Every read is made as the signed-in person, so a page they cannot see is never returned.
 * Each function returns `null` when direct reading is not available (for example an install that
 * has not yet approved the `read:page:confluence` permission), and callers then fall back to
 * search. Pages come back in the shape `pageSource` in normalize.js reads.
 */
import api, { route } from '@forge/api';

const PAGE_ID = /^\d{1,20}$/;
/** Statuses that mean "direct reads are not allowed here", as opposed to "this page is missing". */
const NOT_AVAILABLE = new Set([400, 401, 403]);
/** Titles of decision records, as the space search matches them. */
export const DECISION_TITLE = /\b(?:decision|decisions|decided|agreed|adr)\b/i;
const TEMPLATE_TITLE = /\btemplate\b/i;

/** A v2 page in the v1 shape the rest of the app reads. */
function asV1(page, spaceKey) {
  return {
    id: String(page.id),
    title: page.title,
    _links: { webui: page._links?.webui },
    version: { when: page.version?.createdAt },
    body: page.body,
    ...(spaceKey ? { space: { key: spaceKey } } : {})
  };
}

/**
 * Pages by id, in the order given. A page that is missing or hidden from this person is left out.
 * Null when direct reads are not available.
 */
export async function pagesByIds(ids) {
  const wanted = [...new Set(ids.map(String))].filter((id) => PAGE_ID.test(id));
  if (wanted.length === 0) return [];
  const answers = await Promise.all(wanted.map(async (id) => {
    const response = await api.asUser().requestConfluence(route`/wiki/api/v2/pages/${id}?body-format=atlas_doc_format`);
    if (response.ok) return { page: asV1(await response.json()) };
    return { status: response.status };
  }));
  if (answers.some((a) => NOT_AVAILABLE.has(a.status))) return null;
  if (answers.some((a) => a.status && a.status !== 404)) {
    const status = answers.find((a) => a.status && a.status !== 404).status;
    throw Object.assign(new Error(`Confluence HTTP ${status}`), { status });
  }
  return answers.filter((a) => a.page).map((a) => a.page);
}

/** The numeric space id at the end of a space ARI (`ari:cloud:confluence:<cloud>:space/123`), or null. */
export function spaceIdOf(space) {
  const match = String(space?.id ?? '').match(/space\/(\d{1,20})$/) ?? String(space?.id ?? '').match(/^(\d{1,20})$/);
  return match ? match[1] : null;
}

/**
 * The most recently changed pages in a space whose titles say they hold decisions, newest first.
 * Null when direct reads are not available.
 */
export async function decisionPagesInSpace(spaceId, spaceKey, limit) {
  const response = await api.asUser().requestConfluence(
    route`/wiki/api/v2/spaces/${spaceId}/pages?status=current&sort=-modified-date&limit=${100}&body-format=atlas_doc_format`
  );
  if (NOT_AVAILABLE.has(response.status)) return null;
  if (!response.ok) throw Object.assign(new Error(`Confluence HTTP ${response.status}`), { status: response.status });
  const results = (await response.json())?.results ?? [];
  return results
    .filter((page) => DECISION_TITLE.test(page?.title ?? '') && !TEMPLATE_TITLE.test(page?.title ?? ''))
    .slice(0, limit)
    .map((page) => asV1(page, spaceKey));
}
