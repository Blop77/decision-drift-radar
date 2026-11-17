/**
 * Drift tracking: first-seen times, "new since your last visit", drift opened by a scan, resolved
 * by a later scan or by the Jira issue-update trigger, and reopened when the wording comes back.
 * Fictional fixtures; Forge is replaced by the in-memory mocks in test/mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as any;
const SITE = 'https://example.atlassian.net';
const { applyScan, describeFindings, onIssueUpdated } = await import('../src/resolvers/drift.js');
const { handler } = await import('../src/resolvers/index.js');
const { kvsMemory } = await import('./mocks/kvs.mjs');
/** The stored radar for a project (versioned custom-entity record). */
const storedRadar = (projectKey: string) => kvsMemory.get(`radar-state:${projectKey}`)?.radar;

const t = (text: string) => ({ type: 'text', text });
const doc = (lines: string[]) => ({ type: 'doc', content: lines.map((line) => ({ type: 'paragraph', content: [t(line)] })) });

let description = ['Plan the launch for every channel.', 'Scheduling: this work keeps separate channel plans for now.'];
let pages = [
  { id: '501', title: 'Launch sync: decisions', lines: ['Launch sync for DD.', 'Decision: We agreed to use one shared launch plan instead of separate channel plans. Related Jira issues: DD-1.'] }
];
const jiraCalls: Array<{ path: string; asApp: boolean }> = [];

const rawIssue = () => ({
  id: '20001', key: 'DD-1',
  fields: {
    summary: 'Plan the launch', status: { name: 'To Do' }, labels: [], updated: '2026-11-10T09:00:00.000+0000',
    project: { id: '30001', key: 'DD' }, description: doc(description), comment: { comments: [] }
  }
});

g.__jira = (path: string, json: any, options: any) => {
  jiraCalls.push({ path, asApp: Boolean(options?.asApp) });
  if (/\/project\/DD$/.test(path)) return json({ key: 'DD' });
  if (path.startsWith('/rest/api/3/search/jql')) return json({ issues: [rawIssue()] });
  if (path.startsWith('/rest/api/3/issue/DD-1')) return json(rawIssue());
  return json({}, 404);
};
g.__confluence = (path: string, json: any) => (path.includes('space%20in') || path.includes('id%20in')
  ? json({ results: [] })
  : json({
    results: pages.map((p) => ({
      id: p.id, title: p.title, version: { when: '2026-11-11T10:00:00Z' },
      _links: { base: SITE, webui: `/spaces/DD/pages/${p.id}` },
      body: { atlas_doc_format: { value: JSON.stringify(doc(p.lines)) } }
    }))
  }));
g.__twg = (_q: string, _v: unknown, json: any) => json({ data: { atlassianTeamsBySpace: { edges: [] } } });

const ctx = { accountId: 'person-1', siteUrl: SITE, cloudId: 'cloud-1' };
const scan = () => handler.getProjectRadar({ payload: { projectKey: 'DD' }, context: ctx });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const finding = (id: string, affected: unknown[]) => ({ id, affectedIssues: affected });
const outdated = (issueKey: string, phrase: string) => ({ issueKey, relevance: 0.9, reasons: [], wordingStatus: 'outdated', outdatedWording: phrase });
const plain = (issueKey: string) => ({ issueKey, relevance: 0.5, reasons: [] });
const staleIssue = { key: 'DD-1', title: 'Plan the launch', description: 'Scheduling: separate channel plans.' };
const updatedIssue = { ...staleIssue, description: 'Scheduling: one shared launch plan.' };

test('applyScan opens, keeps, resolves and reopens drifts only on evidence', () => {
  const empty = { findings: {}, drifts: {} };
  const first = applyScan(empty, { candidates: [finding('dc_a', [outdated('DD-1', 'separate channel plans')])], issueRecords: [staleIssue], now: 't1' });
  assert.equal(first.changed, true);
  assert.equal(first.radar.findings.dc_a.firstSeenAt, 't1');
  assert.equal(first.radar.drifts['dc_a:DD-1'].status, 'open');

  const same = applyScan(first.radar, { candidates: [finding('dc_a', [outdated('DD-1', 'separate channel plans')])], issueRecords: [staleIssue], now: 't2', observedAt: 't1' });
  assert.equal(same.changed, false, 'a repeat of the same observation writes nothing');
  const confirmed = applyScan(first.radar, { candidates: [finding('dc_a', [outdated('DD-1', 'separate channel plans')])], issueRecords: [staleIssue], now: 't2' });
  assert.equal(confirmed.changed, true, 'a newer scan that confirms the drift records its observation time');
  assert.equal(confirmed.radar.drifts['dc_a:DD-1'].observedAt, 't2');
  assert.equal(confirmed.radar.drifts['dc_a:DD-1'].status, 'open');

  const findingMissing = applyScan(first.radar, { candidates: [], issueRecords: [staleIssue], now: 't2' });
  assert.equal(findingMissing.radar.drifts['dc_a:DD-1'].status, 'open', 'a finding the scan did not return is not resolved');
  const issueMissing = applyScan(first.radar, { candidates: [finding('dc_a', [])], issueRecords: [{ ...updatedIssue, key: 'DD-2' }], now: 't2' });
  assert.equal(issueMissing.radar.drifts['dc_a:DD-1'].status, 'open', 'an issue the scan did not read is not resolved');

  const lostMatch = applyScan(first.radar, { candidates: [finding('dc_a', [])], issueRecords: [staleIssue], now: 't2' });
  assert.equal(lostMatch.radar.drifts['dc_a:DD-1'].status, 'open', 'a missing match cannot resolve a phrase still in the issue');
  const incompleteIssue = { key: 'DD-1', title: 'Plan the launch' };
  const incomplete = applyScan(first.radar, { candidates: [finding('dc_a', [])], issueRecords: [incompleteIssue], now: 't2' });
  assert.equal(incomplete.radar.drifts['dc_a:DD-1'].status, 'open', 'an omitted description cannot resolve a drift');

  const fixed = applyScan(first.radar, { candidates: [finding('dc_a', [plain('DD-1')])], issueRecords: [updatedIssue], now: 't3' });
  assert.deepEqual(
    { status: fixed.radar.drifts['dc_a:DD-1'].status, at: fixed.radar.drifts['dc_a:DD-1'].resolvedAt, by: fixed.radar.drifts['dc_a:DD-1'].resolvedBy },
    { status: 'resolved', at: 't3', by: 'scan' }
  );

  const back = applyScan(fixed.radar, { candidates: [finding('dc_a', [outdated('DD-1', 'separate channel plans')])], issueRecords: [staleIssue], now: 't4' });
  assert.equal(back.radar.drifts['dc_a:DD-1'].status, 'open');
  assert.equal(back.radar.drifts['dc_a:DD-1'].reopenedAt, 't4');
  assert.equal(back.radar.drifts['dc_a:DD-1'].firstSeenAt, 't1');
});

test('describeFindings marks new findings and lists resolved issues that no longer match', () => {
  const radar = {
    findings: { dc_old: { firstSeenAt: '2026-11-01T00:00:00Z' }, dc_new: { firstSeenAt: '2026-11-12T00:00:00Z' } },
    drifts: { 'dc_old:DD-7': { findingId: 'dc_old', issueKey: 'DD-7', phrase: 'Mondays', status: 'resolved', firstSeenAt: '2026-11-01T00:00:00Z', resolvedAt: '2026-11-05T00:00:00Z', resolvedBy: 'issue-update' } }
  };
  const candidates = [finding('dc_old', []), finding('dc_new', [])];
  const issueRecords = [{ ...updatedIssue, key: 'DD-7' }];
  const [old, fresh] = describeFindings(radar, { candidates, issueRecords, previousVisitAt: '2026-11-10T00:00:00Z' });
  assert.equal(old.isNew, false);
  assert.equal(fresh.isNew, true);
  assert.deepEqual(old.resolvedIssues.map((r: any) => [r.issueKey, r.status, r.resolvedBy]), [['DD-7', 'resolved', 'issue-update']]);
  const [hidden] = describeFindings(radar, { candidates, issueRecords: [] });
  assert.deepEqual(hidden.resolvedIssues, [], 'a scan cannot show history for an issue it did not read');
  const [firstVisit] = describeFindings(radar, { candidates: [finding('dc_new', [])], issueRecords });
  assert.equal(firstVisit.isNew, false, 'nothing is "new" on a first visit');
});

test('project scans track drift, resolve it when the issue is fixed, and flag new findings', async () => {
  kvsMemory.clear();
  const first = await scan();
  assert.equal(first.ok, true);
  assert.equal(first.previousVisitAt, null);
  assert.deepEqual(first.radar, { findings: 1, newSinceLastVisit: 0, drifting: 1, newDrifts: 0, resolved: 0, issuesDrifting: 1 });
  const decision = first.candidates[0];
  const dd1 = decision.affectedIssues.find((a: any) => a.issueKey === 'DD-1');
  assert.equal(dd1.drift.status, 'open');
  assert.equal(dd1.drift.phrase, 'separate channel plans');

  description = ['Plan the launch for every channel.', 'Scheduling: this work follows the shared launch plan.'];
  await pause(5);
  const second = await scan();
  assert.ok(second.previousVisitAt);
  assert.deepEqual(second.radar, { findings: 1, newSinceLastVisit: 0, drifting: 0, newDrifts: 0, resolved: 1, issuesDrifting: 0 });
  const resolved = [...second.candidates[0].affectedIssues.map((a: any) => a.drift), ...second.candidates[0].resolvedIssues].find(Boolean);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedBy, 'scan');

  pages = [...pages, { id: '502', title: 'Release decisions', lines: ['Decision: We agreed to publish release notes on Fridays instead of Mondays. Related Jira issues: DD-1.'] }];
  await pause(5);
  const third = await scan();
  const added = third.candidates.find((c: any) => c.summary.includes('release notes'));
  assert.equal(added.isNew, true, 'a finding first seen after the last visit is new');
  assert.equal(third.candidates.find((c: any) => c.summary.includes('shared launch plan')).isNew, false);
  assert.equal(third.radar.newSinceLastVisit, 1);
});

test('the issue-update trigger resolves a drift once the wording is gone, reading only that issue as the app', async () => {
  kvsMemory.clear();
  pages = pages.slice(0, 1);
  description = ['Scheduling: this work keeps separate channel plans for now.'];
  await scan();
  assert.equal(Object.values(storedRadar('DD').drifts).filter((d: any) => d.status === 'open').length, 1);

  jiraCalls.length = 0;
  const statusOnly = await onIssueUpdated({ issue: { key: 'DD-1', fields: { project: { key: 'DD' } } }, changelog: { items: [{ field: 'status', fieldId: 'status' }] } });
  assert.deepEqual(statusOnly, { checked: 0, resolved: 0, opened: 0 });
  assert.equal(jiraCalls.length, 0, 'unrelated edits read nothing');

  const descriptionEdit = { issue: { key: 'DD-1', fields: { project: { key: 'DD' } } }, changelog: { items: [{ fieldId: 'description' }] } };
  const stillThere = await onIssueUpdated(descriptionEdit);
  assert.deepEqual(stillThere, { checked: 1, resolved: 0, opened: 0 });

  const originalJira = g.__jira;
  try {
    g.__jira = (_path: string, json: any) => json({ fields: { summary: 'Plan the launch' } });
    assert.deepEqual(await onIssueUpdated(descriptionEdit), { checked: 1, resolved: 0, opened: 0 }, 'missing description is not evidence');
  } finally {
    g.__jira = originalJira;
  }

  description = ['Scheduling: this work follows the shared launch plan.'];
  jiraCalls.length = 0;
  const fixed = await onIssueUpdated(descriptionEdit);
  assert.deepEqual(fixed, { checked: 1, resolved: 1, opened: 0 });
  assert.deepEqual([...jiraCalls], [{ path: '/rest/api/3/issue/DD-1?fields=summary,description,assignee,reporter', asApp: true }]);
  const drift: any = Object.values(storedRadar('DD').drifts)[0];
  assert.equal(drift.status, 'resolved');
  assert.equal(drift.resolvedBy, 'issue-update');

  const none = await onIssueUpdated({ issue: { key: 'DD-2' }, changelog: { items: [{ fieldId: 'description' }] } });
  assert.deepEqual(none, { checked: 0, resolved: 0, opened: 0 }, 'an issue without the replaced wording opens nothing');
});

test('the radar never blocks a scan when its record cannot be read', async () => {
  const kvsModule: any = await import('./mocks/kvs.mjs');
  const get = kvsModule.kvs.get;
  kvsModule.kvs.get = async (key: string) => { if (key.startsWith('radar-state:')) throw new Error('storage down'); return get(key); };
  try {
    const result = await scan();
    assert.equal(result.ok, true);
    assert.equal(result.radar, null);
    assert.match(result.radarWarning, /Drift history is unavailable/);
    assert.ok(result.candidates.length > 0);
  } finally {
    kvsModule.kvs.get = get;
  }
});

test('totals count drifts, not issues: two decisions on one issue are two open drifts', async () => {
  const { applyScan: apply, describeFindings: describe, radarSummary: summarize } = await import('../src/resolvers/drift.js');
  const issue = { key: 'DD-9', title: 'Plan the launch', description: 'Scheduling: separate channel plans, on Mondays.' };
  const two = [
    { id: 'dc_one', summary: 'Use one shared plan instead of separate channel plans.', affectedIssues: [outdated('DD-9', 'separate channel plans')] },
    { id: 'dc_two', summary: 'Send on Fridays instead of on Mondays.', affectedIssues: [outdated('DD-9', 'on Mondays')] }
  ];
  const { radar } = apply({ findings: {}, drifts: {} }, { candidates: two, issueRecords: [issue], now: 't1' });
  const counts = summarize(describe(radar, { candidates: two, issueRecords: [issue] }));
  assert.equal(counts.drifting, 2, 'one open drift per decision and issue');
  assert.equal(counts.issuesDrifting, 1, 'but only one issue');
});

// ---------------------------------------------------------------------------------------------
// Proactive detection: the issue trigger opens drift when an issue is created or edited to use
// wording a decision the project's scans already found replaced.
// ---------------------------------------------------------------------------------------------

const { watchFor, radarSummary } = await import('../src/resolvers/drift.js');

test('only multi-word replaced wording with a real word is watched', () => {
  assert.deepEqual(watchFor('We agreed to use one shared launch plan instead of separate channel plans.'),
    { phrase: 'separate channel plans', replacement: 'one shared launch plan' });
  assert.equal(watchFor('Status updates go out on Fridays instead of on Mondays.')?.phrase, 'on Mondays');
  assert.equal(watchFor('We decided to ship it.'), null, 'no replaced wording, nothing to watch');
  assert.equal(watchFor('Use the new form instead of the old.')?.phrase ?? null, null, 'short generic words are not watched');
});

/** Runs `body` with extra issues (key → description lines) readable through the Jira mock. */
async function withIssues(extra: Record<string, string[]>, body: () => Promise<void>) {
  const original = g.__jira;
  g.__jira = (path: string, json: any, options: any) => {
    const key = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)\?/.exec(path)?.[1];
    if (key && extra[key]) {
      jiraCalls.push({ path, asApp: Boolean(options?.asApp) });
      return json({ key, fields: { summary: `Issue ${key}`, project: { key: key.split('-')[0] }, description: doc(extra[key]) } });
    }
    return original(path, json, options);
  };
  try { await body(); } finally { g.__jira = original; }
}
const created = (key: string) => ({ eventType: 'avi:jira:created:issue', issue: { key, fields: { project: { key: key.split('-')[0] } } } });
const edited = (key: string, field = 'description') => ({
  eventType: 'avi:jira:updated:issue', issue: { key, fields: { project: { key: key.split('-')[0] } } }, changelog: { items: [{ fieldId: field }] }
});

test('a scan records the wording each decision replaced, so the trigger can watch for it', async () => {
  kvsMemory.clear();
  pages = pages.slice(0, 1);
  description = ['Scheduling: this work keeps separate channel plans for now.'];
  await scan();
  const watched = Object.values(storedRadar('DD').findings).map((f: any) => f.watch).filter(Boolean);
  assert.deepEqual(watched, [{ phrase: 'separate channel plans', replacement: 'one shared launch plan' }]);
});

test('a new issue that uses replaced wording opens a drift without a scan, reading only that issue', async () => {
  kvsMemory.clear();
  description = ['Scheduling: this work follows one shared launch plan.'];
  await scan();
  const logs: string[] = [];
  const info = console.info;
  console.info = (line: string) => { logs.push(String(line)); };
  try {
    await withIssues({ 'DD-2': ['Email campaign.', 'We will keep separate channel plans for email.'] }, async () => {
      jiraCalls.length = 0;
      assert.deepEqual(await onIssueUpdated(created('DD-2')), { checked: 0, resolved: 0, opened: 1 });
      assert.deepEqual([...jiraCalls], [{ path: '/rest/api/3/issue/DD-2?fields=summary,description,assignee,reporter', asApp: true }]);
      assert.deepEqual(await onIssueUpdated(created('DD-2')), { checked: 1, resolved: 0, opened: 0 }, 'a repeated event changes nothing');
    });
  } finally {
    console.info = info;
  }
  const drift: any = Object.values(storedRadar('DD').drifts).find((d: any) => d.issueKey === 'DD-2');
  assert.equal(drift.status, 'open');
  assert.equal(drift.foundBy, 'issue-create');
  assert.equal(drift.phrase, 'separate channel plans');
  assert.ok(logs.every((line) => !line.includes('separate') && !line.includes('Email')), 'logs carry no issue or decision text');
});

test('an edit that adds the wording opens a drift; removing it resolves; adding it back reopens with the first date', async () => {
  kvsMemory.clear();
  description = ['Scheduling: this work follows one shared launch plan.'];
  await scan();
  const text: Record<string, string[]> = { 'DD-3': ['Social posts.', 'Keep separate channel plans for social.'] };
  await withIssues(text, async () => {
    assert.deepEqual(await onIssueUpdated(edited('DD-3')), { checked: 0, resolved: 0, opened: 1 });
    const opened: any = storedRadar('DD').drifts[Object.keys(storedRadar('DD').drifts).find((k) => k.endsWith(':DD-3'))!];
    assert.equal(opened.foundBy, 'issue-edit');
    const firstSeenAt = opened.firstSeenAt;

    text['DD-3'] = ['Social posts.', 'Follow the shared plan.'];
    assert.deepEqual(await onIssueUpdated(edited('DD-3')), { checked: 1, resolved: 1, opened: 0 });

    await pause(5);
    text['DD-3'] = ['Social posts.', 'Back to separate channel plans.'];
    assert.deepEqual(await onIssueUpdated(edited('DD-3', 'summary')), { checked: 0, resolved: 0, opened: 1 });
    const back: any = Object.values(storedRadar('DD').drifts).find((d: any) => d.issueKey === 'DD-3');
    assert.equal(back.status, 'open');
    assert.equal(back.reopenedBy, 'issue-edit');
    assert.equal(back.firstSeenAt, firstSeenAt, 'a reopened drift keeps its original date');
  });
});

test('the trigger ignores its own events, other fields, and projects with nothing to watch', async () => {
  kvsMemory.clear();
  description = ['Scheduling: this work follows one shared launch plan.'];
  await scan();
  await withIssues({ 'DD-4': ['Keep separate channel plans.'], 'ZZ-1': ['Keep separate channel plans.'] }, async () => {
    jiraCalls.length = 0;
    assert.deepEqual(await onIssueUpdated({ ...created('DD-4'), selfGenerated: true }), { checked: 0, resolved: 0, opened: 0 });
    assert.deepEqual(await onIssueUpdated(edited('DD-4', 'status')), { checked: 0, resolved: 0, opened: 0 });
    assert.deepEqual(await onIssueUpdated(created('ZZ-1')), { checked: 0, resolved: 0, opened: 0 }, 'no radar for ZZ, nothing watched');
    assert.equal(jiraCalls.length, 0, 'none of these read an issue');
  });
});

test('a drift found by the trigger is shown only in a scan that lists the issue, with its cause and as new', () => {
  const radar = {
    findings: { dc_a: { firstSeenAt: 't0', watch: { phrase: 'separate channel plans' } } },
    drifts: { 'dc_a:DD-2': { findingId: 'dc_a', issueKey: 'DD-2', phrase: 'separate channel plans', status: 'open', firstSeenAt: 't5', foundBy: 'issue-edit', observedAt: 't5' } }
  };
  const issue = { key: 'DD-2', title: 'Email', description: 'Keep separate channel plans.' };
  const listed = describeFindings(radar, { candidates: [finding('dc_a', [outdated('DD-2', 'separate channel plans')])], issueRecords: [issue], previousVisitAt: 't3' });
  assert.equal(listed[0].affectedIssues[0].drift.foundBy, 'issue-edit');
  assert.equal(listed[0].affectedIssues[0].drift.isNew, true);
  assert.equal(radarSummary(listed).newDrifts, 1);

  const seenBefore = describeFindings(radar, { candidates: [finding('dc_a', [outdated('DD-2', 'separate channel plans')])], issueRecords: [issue], previousVisitAt: 't9' });
  assert.equal(radarSummary(seenBefore).newDrifts, 0, 'not new once the viewer visited after it was found');

  const otherViewer = describeFindings(radar, { candidates: [], issueRecords: [issue], previousVisitAt: 't3' });
  assert.equal(otherViewer.length, 0, 'a viewer whose scan does not return the decision sees nothing');
  assert.equal(radarSummary(otherViewer).newDrifts, 0);
});
