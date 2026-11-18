/**
 * Direct page reads: a team-space page, a linked page and a page added by link are found as soon
 * as they are published, even while Confluence search has not indexed them yet. Fictional fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as any;
const { discoverViaGraph } = await import('../src/resolvers/graph.js');
const { pagesByIds, decisionPagesInSpace, spaceIdOf } = await import('../src/resolvers/confluence-direct.js');
const { linkedPageSources } = await import('../src/resolvers/linked-pages.js');
const { kvsMemory } = await import('./mocks/kvs.mjs');

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const edges = (list: unknown[]) => ({ edges: list.map((node) => ({ node })) });
const adf = (text: string) => ({ atlas_doc_format: { value: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }) } });
const v2page = (id: string, title: string, text: string) => ({
  id, title, spaceId: '123', version: { createdAt: '2026-11-18T07:06:00Z', authorId: 'a1' },
  _links: { webui: `/spaces/TEAM/pages/${id}` }, body: adf(text)
});

/** Search has indexed nothing yet: every CQL search answers with no results. */
function searchFindsNothing() {
  const searches: string[] = [];
  g.__confluence = (path: string) => { searches.push(path); return json({ results: [] }); };
  return searches;
}

test('a space id is read from the space ARI', () => {
  assert.equal(spaceIdOf({ id: 'ari:cloud:confluence:cloud-1:space/123' }), '123');
  assert.equal(spaceIdOf({ id: '456' }), '456');
  assert.equal(spaceIdOf({ id: 'ari:space/LT' }), null, 'no numeric id: the app searches instead');
});

test('a team-space decision page is found without search, newest first, templates and other titles skipped', async () => {
  const searches = searchFindsNothing();
  const requested: string[] = [];
  g.__confluenceV2 = (path: string) => {
    requested.push(path);
    if (path.startsWith('/wiki/api/v2/spaces/123/pages')) {
      return json({ results: [
        v2page('11', 'Team decisions', 'Decision: Status updates go out on Fridays instead of on Mondays.'),
        v2page('12', 'Decision record template', 'Decision: …'),
        v2page('13', 'Lunch menu', 'Pizza on Friday.')
      ] });
    }
    return json({}, 404);
  };
  g.__twg = (query: string) => json({ data: query.includes('atlassianTeamsBySpace')
    ? { atlassianTeamsBySpace: edges([{ __typename: 'AtlassianTeam', id: 'ari:team/1', displayName: 'Launch team' }]) }
    : query.includes('spacesByAtlassianTeam')
      ? { spacesByAtlassianTeam: edges([{ __typename: 'ConfluenceSpace', id: 'ari:cloud:confluence:cloud-1:space/123', key: 'TEAM', name: 'Team' }]) }
      : { confluencePageLinkedConfluencePages: edges([]) } });
  try {
    const { pages, summary } = await discoverViaGraph({ projectKey: 'SCRUM', projectId: '10000', cloudId: 'cloud-1' });
    assert.deepEqual(pages.map((p: any) => p.title), ['Team decisions']);
    assert.match(pages[0].text, /Fridays instead of on Mondays/);
    assert.match(pages[0].via, /^Teamwork Graph: a Confluence space of team Launch team, linked to SCRUM/);
    assert.equal(pages[0].updatedAt, '2026-11-18T07:06:00Z');
    assert.equal(summary.pagesAdded, 1);
    assert.ok(requested[0].includes('status=current') && requested[0].includes('sort=-modified-date') && requested[0].includes('body-format=atlas_doc_format'));
    assert.deepEqual(searches.filter((p) => p.includes('space%20in')), [], 'no space search was needed');
  } finally {
    delete g.__confluenceV2;
  }
});

test('pages by id: found directly, missing ones left out, and null when direct reads are not allowed', async () => {
  g.__confluenceV2 = (path: string) => (path.startsWith('/wiki/api/v2/pages/7?') ? json(v2page('7', 'Decision log', 'Decision: Yes.')) : json({}, 404));
  try {
    const pages = await pagesByIds(['7', '8', 'not-a-number']);
    assert.deepEqual(pages.map((p: any) => [p.id, p.title, p.version.when]), [['7', 'Decision log', '2026-11-18T07:06:00Z']]);
  } finally {
    delete g.__confluenceV2;
  }
  assert.equal(await pagesByIds(['7']), null, 'the default mock answers 403, as an install without the permission does');
  assert.equal(await decisionPagesInSpace('123', 'TEAM', 5), null);
});

test('a page added by link is scanned at once, even when search has not indexed it', async () => {
  searchFindsNothing();
  kvsMemory.set('linked-pages:SCRUM', [{ id: '7', addedAt: '2026-11-18T07:00:00Z' }, { id: '8', addedAt: '2026-11-18T07:00:00Z' }]);
  g.__confluenceV2 = (path: string) => (path.startsWith('/wiki/api/v2/pages/7?') ? json(v2page('7', 'Decision log', 'Decision: We agreed to ship on Fridays.')) : json({}, 404));
  try {
    const { pages, hidden } = await linkedPageSources('SCRUM');
    assert.deepEqual(pages.map((p: any) => [p.id, p.title]), [['page-7', 'Decision log']]);
    assert.equal(hidden, 1, 'a page this person cannot open is counted, not shown');
  } finally {
    delete g.__confluenceV2;
    kvsMemory.delete('linked-pages:SCRUM');
  }
});
