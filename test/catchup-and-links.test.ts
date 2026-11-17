/**
 * Pages added by link (read directly, no search wait) and the scheduled catch-up that re-checks
 * recently updated issues when Jira did not deliver their events. Fictional fixtures; Forge is
 * replaced by the in-memory mocks in test/mocks.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as any;
const SITE = 'https://example.atlassian.net';
const { catchUpDrift } = await import('../src/resolvers/drift.js');
const { pageIdFromLink } = await import('../src/resolvers/linked-pages.js');
// Pages are read by id through Confluence search (the app's existing read permission).
const { handler } = await import('../src/resolvers/index.js');
const { kvsMemory } = await import('./mocks/kvs.mjs');

const t = (text: string) => ({ type: 'text', text });
const doc = (lines: string[]) => ({ type: 'doc', content: lines.map((line) => ({ type: 'paragraph', content: [t(line)] })) });
const ctx = { accountId: 'person-1', siteUrl: SITE, cloudId: 'cloud-1' };
const DECISION = 'Decision: Status updates go out on Fridays instead of on Mondays.';
const PRIVATE_TITLE = 'Private decisions page';

let searchPages: Array<{ id: string; lines: string[] }>;
let readablePages: Record<string, string[]>;
let issueText: string;
let issueCreated: string;
let canEdit: boolean;
let catchUpSearchStatus: number;
let calls: Array<{ path: string; asApp: boolean }>;

const rawIssue = () => ({
  id: '20001', key: 'DD-1',
  fields: {
    summary: 'Weekly status', status: { name: 'To Do' }, labels: [], updated: '2026-11-16T09:00:00.000+0000',
    created: issueCreated, project: { id: '30001', key: 'DD' }, description: doc([issueText]), comment: { comments: [] },
    assignee: { accountId: 'acct-a' }, reporter: { accountId: 'acct-a' }
  }
});
const page = (id: string, lines: string[]) => ({
  id, type: 'page', title: PRIVATE_TITLE, version: { when: '2026-11-16T08:00:00Z' },
  _links: { base: SITE, webui: `/spaces/DD/pages/${id}` }, body: { atlas_doc_format: { value: JSON.stringify(doc(lines)) } }
});

beforeEach(() => {
  kvsMemory.clear();
  searchPages = [];
  readablePages = { 777: [DECISION] };
  issueText = 'Post the weekly status update.';
  issueCreated = '2026-01-01T00:00:00.000+0000';
  canEdit = true;
  catchUpSearchStatus = 200;
  calls = [];
  g.__jira = (path: string, json: any, options: any) => {
    calls.push({ path, asApp: Boolean(options?.asApp) });
    if (path.includes('/mypermissions')) {
      return json({ permissions: {
        BROWSE_PROJECTS: { havePermission: true }, ADD_COMMENTS: { havePermission: canEdit },
        EDIT_ISSUES: { havePermission: canEdit }, ADMINISTER_PROJECTS: { havePermission: false }
      } });
    }
    if (/\/project\/DD$/.test(path)) return json({ key: 'DD', id: '30001' });
    if (path.startsWith('/rest/api/3/search/jql')) {
      if (options?.asApp) return catchUpSearchStatus === 200 ? json({ issues: [rawIssue()] }) : json({}, catchUpSearchStatus);
      return json({ issues: [rawIssue()] });
    }
    if (path.endsWith('/notify')) return json({}, 204);
    if (path.startsWith('/rest/api/3/issue/DD-1')) return json(rawIssue());
    return json({}, 404);
  };
  g.__confluence = (path: string, json: any) => {
    const byId = decodeURIComponent(path).match(/type = page AND id in \(([\d,]+)\)/);
    if (byId) {
      const ids = byId[1].split(',');
      return json({ results: ids.filter((id) => readablePages[id]).map((id) => page(id, readablePages[id])) });
    }
    if (path.includes('space%20in') || path.includes('id%20in')) return json({ results: [] });
    return json({ results: searchPages.map((p) => page(p.id, p.lines)) });
  };
  g.__twg = (_q: string, _v: unknown, json: any) => json({ data: { atlassianTeamsBySpace: { edges: [] } } });
});

const scan = () => handler.getProjectRadar({ payload: { projectKey: 'DD' }, context: ctx });
const addLink = (link: string) => handler.addLinkedPage({ payload: { projectKey: 'DD', link }, context: ctx });

test('page links are read from the path, the edit path, pageId or a bare id, and nothing else', () => {
  assert.equal(pageIdFromLink(`${SITE}/wiki/spaces/DD/pages/777/Decisions`), '777');
  assert.equal(pageIdFromLink(`${SITE}/wiki/spaces/DD/pages/edit-v2/777`), '777');
  assert.equal(pageIdFromLink(`${SITE}/wiki/pages/viewpage.action?pageId=777`), '777');
  assert.equal(pageIdFromLink(' 777 '), '777');
  for (const bad of ['', 'not a link', `http://example.atlassian.net/wiki/spaces/DD/pages/777`, `${SITE}/wiki/spaces/DD/overview`]) {
    assert.equal(pageIdFromLink(bad), null, bad);
  }
});

test('a page added by link is scanned even when it never names the project and the key search finds nothing', async () => {
  const before = await scan();
  assert.equal(before.pages.length, 0);
  assert.equal(before.candidates.length, 0);

  const added = await addLink(`${SITE}/wiki/spaces/DD/pages/777/Decisions`);
  assert.equal(added.ok, true);
  assert.equal(added.added.title, PRIVATE_TITLE);
  assert.deepEqual(kvsMemory.get('linked-pages:DD').map((entry: any) => Object.keys(entry).sort()), [['addedAt', 'id']], 'only ids and times are stored');

  const after = await scan();
  assert.equal(after.pages.length, 1);
  assert.equal(after.pages[0].via, 'a link added to this project');
  assert.ok(after.candidates.some((c: any) => c.summary.includes('Fridays instead of on Mondays')));

  searchPages = [{ id: '777', lines: [DECISION, 'Related project: DD.'] }];
  assert.equal((await scan()).pages.length, 1, 'a page found by search and by link is scanned once');
});

test('adding pages needs comment or edit permission, a visible page, no duplicates and at most ten', async () => {
  canEdit = false;
  assert.match((await addLink('777')).error, /permission to add comments or edit issues/);
  canEdit = true;
  assert.match((await addLink('999')).error, /No Confluence page with that link is visible to you/);
  assert.equal((await addLink('777')).ok, true);
  assert.match((await addLink('777')).error, /already added/);
  for (let id = 1000; id < 1009; id++) {
    readablePages[id] = ['Notes.'];
    assert.equal((await addLink(String(id))).ok, true);
  }
  readablePages[2000] = ['Notes.'];
  assert.match((await addLink('2000')).error, /up to 10 pages/);
  assert.equal((await handler.removeLinkedPage({ payload: { projectKey: 'DD', pageId: '1000' }, context: ctx })).ok, true);
  assert.equal((await addLink('2000')).ok, true);
});

test('a linked page this person cannot open is skipped and counted, not shown', async () => {
  assert.equal((await addLink('777')).ok, true);
  delete readablePages[777];
  const result = await scan();
  assert.equal(result.pages.length, 0);
  assert.equal(result.linkedHidden, 1);
  const listed = await handler.getLinkedPages({ payload: { projectKey: 'DD' }, context: ctx });
  assert.deepEqual([listed.pages.length, listed.hidden], [0, 1]);
});

test('the catch-up opens a drift Jira never announced, once, and notifies once', async (t) => {
  t.mock.method(console, 'info', () => {});
  assert.equal((await addLink('777')).ok, true);
  await scan();
  assert.equal(kvsMemory.get('radar-watch:DD'), true, 'a scan that stores a watched phrase marks the project');
  kvsMemory.set('drift-notifications:DD', true);

  issueText = 'Status updates go out on Mondays.';
  issueCreated = new Date().toISOString();
  const first = await catchUpDrift();
  assert.deepEqual(first, { projects: 1, issues: 1, opened: 1, resolved: 0 });
  const drifts = Object.values(kvsMemory.get('radar-state:DD').radar.drifts) as any[];
  assert.deepEqual(drifts.map((d) => [d.issueKey, d.status, d.foundBy]), [['DD-1', 'open', 'issue-create']]);
  const notifies = () => calls.filter((c) => c.path.endsWith('/notify'));
  assert.equal(notifies().length, 1);

  const second = await catchUpDrift();
  assert.equal(second.opened, 0, 'overlapping windows change nothing');
  assert.equal(notifies().length, 1, 'and send nothing again');
  assert.ok(calls.filter((c) => c.path.startsWith('/rest/api/3/search/jql') && c.asApp).every((c) => decodeURIComponent(c.path).includes('updated >= -10m')));
});

test('the catch-up resolves a drift whose wording is gone and does nothing without watched projects', async (t) => {
  t.mock.method(console, 'info', () => {});
  assert.deepEqual(await catchUpDrift(), { projects: 0, issues: 0, opened: 0, resolved: 0 });
  assert.equal(calls.length, 0, 'no watched project, no Jira calls');

  issueText = 'Status updates go out on Mondays.';
  assert.equal((await addLink('777')).ok, true);
  await scan();
  issueText = 'Status updates go out on Fridays.';
  const result = await catchUpDrift();
  assert.equal(result.resolved, 1);
  const drift = Object.values(kvsMemory.get('radar-state:DD').radar.drifts)[0] as any;
  assert.deepEqual([drift.status, drift.resolvedBy], ['resolved', 'issue-update']);
});

test('a failed catch-up search is logged with the key and status only and the run goes on', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal((await addLink('777')).ok, true);
  await scan();
  catchUpSearchStatus = 503;
  assert.deepEqual(await catchUpDrift(), { projects: 1, issues: 0, opened: 0, resolved: 0 });
  const lines = [...warn.mock.calls, ...info.mock.calls].map(({ arguments: args }) => args.join(' '));
  assert.ok(lines.includes('Decision Drift Radar catch-up search: DD, HTTP 503'));
  for (const line of lines) for (const secret of [PRIVATE_TITLE, 'Mondays', 'Fridays']) assert.ok(!line.includes(secret), line);
});
