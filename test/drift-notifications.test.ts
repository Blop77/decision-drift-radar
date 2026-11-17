import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { kvsMemory } from './mocks/kvs.mjs';
import { onIssueUpdated, applyScan } from '../src/resolvers/drift.js';
import { handler } from '../src/resolvers/index.js';

const g = globalThis as any;
const issueKey = 'DD-1';
const projectKey = 'DD';
const findingId = 'dc_1111111111111111';
const driftId = `${findingId}:${issueKey}`;
const radarKey = 'radar-state:DD';
const settingKey = 'drift-notifications:DD';
const phrase = 'old private phrase';
const title = 'Private issue title';
const oldTime = '2026-01-01T00:00:00.000Z';
const issueFor = (key = issueKey) => ({ key, fields: { project: { key: projectKey } } });
const created = (key = issueKey) => ({ eventType: 'avi:jira:created:issue', issue: issueFor(key) });
const edit = () => ({
  eventType: 'avi:jira:updated:issue', issue: issueFor(), changelog: { items: [{ fieldId: 'summary' }] }
});
const drift = () => kvsMemory.get(radarKey).radar.drifts[driftId];
const requests: { path: string; options: any }[] = [];
let issueText: string;
let notifyStatus: number;
let canAdminister: boolean;
let loseNotifyResponse: boolean;
let people: { assignee?: any; reporter?: any };

beforeEach(() => {
  kvsMemory.clear();
  requests.length = 0;
  issueText = phrase;
  notifyStatus = 204;
  canAdminister = false;
  loseNotifyResponse = false;
  people = { assignee: { accountId: 'acct-a', displayName: 'Private Name' }, reporter: { accountId: 'acct-a' } };
  kvsMemory.set(radarKey, {
    projectKey, version: 1, radar: {
      findings: { [findingId]: { firstSeenAt: oldTime, watch: { phrase } } },
      drifts: {}
    }
  });
  g.__jira = (path: string, json: any, options: any) => {
    requests.push({ path, options });
    if (path.endsWith('/notify')) {
      assert.equal(options.asApp, true);
      assert.equal(options.method, 'POST');
      if (loseNotifyResponse) throw new Error(`Jira error with private text: ${issueText}`);
      return json({}, notifyStatus);
    }
    if (path.includes('/mypermissions')) return json({
      permissions: { ADMINISTER_PROJECTS: { havePermission: canAdminister } }
    });
    return json({ fields: { summary: title, ...people, description: {
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: issueText }] }]
    } } });
  };
});

const notifyRequests = () => requests.filter(({ path }) => path.endsWith('/notify'));

test('a project defaults to off and the trigger still saves the new drift', async () => {
  await onIssueUpdated(created());
  assert.equal(drift().foundBy, 'issue-create');
  assert.equal(drift().notifiedAt, undefined);
  assert.equal(notifyRequests().length, 0);
});

test('a trigger posts one fixed notification despite simultaneous delivery and later reopening', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  kvsMemory.set(settingKey, true);
  await Promise.all([onIssueUpdated(created()), onIssueUpdated(created())]);
  assert.equal(notifyRequests().length, 1);
  const [{ path, options }] = notifyRequests();
  assert.equal(path, '/rest/api/3/issue/DD-1/notify');
  assert.deepEqual(JSON.parse(options.body), {
    to: { users: [{ accountId: 'acct-a' }] },
    subject: 'Decision Drift Radar: a recorded decision may affect DD-1',
    textBody: 'A recorded decision may affect this issue. Open Decision Drift Radar on the issue to check the evidence you have access to.',
    htmlBody: '<p>A recorded decision may affect this issue. Open Decision Drift Radar on the issue to check the evidence you have access to.</p>'
  });
  assert.equal(options.body.includes('Private Name'), false);
  assert.equal(options.body.includes(phrase), false);
  assert.equal(options.body.includes(title), false);
  const notifiedAt = drift().notifiedAt;
  assert.ok(notifiedAt);

  issueText = 'Current wording';
  await onIssueUpdated(edit());
  assert.equal(drift().status, 'resolved');
  const resolved = structuredClone(kvsMemory.get(radarKey).radar);
  issueText = phrase;
  await onIssueUpdated(edit());
  assert.equal(drift().reopenedBy, 'issue-edit');
  assert.equal(drift().notifiedAt, notifiedAt);
  assert.equal(notifyRequests().length, 1);

  const scanned = applyScan(resolved, {
    candidates: [{ id: findingId, summary: 'Decision.', affectedIssues: [
      { issueKey, wordingStatus: 'outdated', outdatedWording: phrase }
    ] }],
    issueRecords: [{ key: issueKey, title, description: phrase }]
  });
  assert.equal(scanned.radar.drifts[driftId].notifiedAt, notifiedAt);
  const notificationLogs = info.mock.calls
    .map(({ arguments: args }) => args)
    .filter(([message]) => String(message).startsWith('Decision Drift Radar notification:'));
  assert.deepEqual(notificationLogs, [['Decision Drift Radar notification: DD-1, HTTP 204']]);
});

test('ordinary scans and self-generated events do not notify', async () => {
  kvsMemory.set(settingKey, true);
  await onIssueUpdated({ ...created(), selfGenerated: true });
  assert.equal(requests.length, 0);
  assert.equal(drift(), undefined);
  const radar = kvsMemory.get(radarKey).radar;
  const scanned = applyScan(radar, {
    candidates: [{ id: findingId, summary: 'Decision.', affectedIssues: [
      { issueKey, wordingStatus: 'outdated', outdatedWording: phrase }
    ] }],
    issueRecords: [{ key: issueKey, title, description: phrase }]
  });
  assert.equal(scanned.radar.drifts[driftId].status, 'open');
  assert.equal(notifyRequests().length, 0);
});

test('the daily cap is atomic across different issues and resets at UTC midnight', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-15T23:59:00Z') });
  kvsMemory.set(settingKey, true);
  const countKey = 'drift-notification-count:DD:2026-11-15';
  const counterWrites: string[] = [];
  g.__kvsHook = async (op: string, key: string, options: any) => {
    if (!key.startsWith('drift-notification-count:') || op === 'get') return;
    assert.deepEqual(options.ttl, { unit: 'DAYS', value: 2 });
    counterWrites.push(op);
  };
  t.after(() => { delete g.__kvsHook; });
  kvsMemory.set(countKey, { projectKey, version: 19 });
  await Promise.all([onIssueUpdated(created('DD-1')), onIssueUpdated(created('DD-2'))]);
  assert.equal(notifyRequests().length, 1);
  assert.equal(kvsMemory.get(countKey).version, 20);
  assert.equal(Object.keys(kvsMemory.get(radarKey).radar.drifts).length, 2);
  await onIssueUpdated(created('DD-3'));
  assert.equal(notifyRequests().length, 1);
  t.mock.timers.setTime(Date.parse('2026-11-16T00:00:00Z'));
  await onIssueUpdated(created('DD-4'));
  assert.equal(notifyRequests().length, 2);
  assert.equal(kvsMemory.get('drift-notification-count:DD:2026-11-16').version, 1);
  assert.ok(counterWrites.includes('transact') && counterWrites.includes('set'));
});

test('a Jira failure preserves the drift and notification logs contain only the key and status', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  kvsMemory.set(settingKey, true);
  notifyStatus = 403;
  await onIssueUpdated(edit());
  assert.equal(drift().foundBy, 'issue-edit');
  assert.equal(drift().notifiedAt, undefined);
  assert.deepEqual(warnings.mock.calls.map(({ arguments: args }) => args), [
    ['Decision Drift Radar notification: DD-1, HTTP 403']
  ]);
  await onIssueUpdated(edit());
  assert.equal(notifyRequests().length, 1);
});

test('a lost Jira response cannot send again even if the radar entry was pruned', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  kvsMemory.set(settingKey, true);
  loseNotifyResponse = true;
  await onIssueUpdated(edit());
  assert.ok(drift());
  const state = kvsMemory.get(radarKey);
  delete state.radar.drifts[driftId];
  kvsMemory.set(radarKey, state);
  await onIssueUpdated(edit());
  assert.equal(notifyRequests().length, 1);
  assert.ok(drift());
  assert.deepEqual(warnings.mock.calls.map(({ arguments: args }) => args), [
    ['Decision Drift Radar notification: DD-1, HTTP status unavailable']
  ]);
});

test('settings require project administration as the signed-in user', async () => {
  const input = { payload: { projectKey, enabled: true }, context: { accountId: 'tester' } };
  assert.deepEqual(await handler.getDriftNotificationSetting(input), { ok: true, canManage: false });
  assert.equal((await handler.setDriftNotificationSetting(input)).ok, false);
  assert.equal(kvsMemory.has(settingKey), false);
  assert.equal(requests.every(({ path, options }) =>
    path.endsWith('/mypermissions?projectKey=DD&permissions=ADMINISTER_PROJECTS') && !options?.asApp), true);

  canAdminister = true;
  assert.deepEqual(await handler.getDriftNotificationSetting(input), { ok: true, canManage: true, enabled: false });
  assert.deepEqual(await handler.setDriftNotificationSetting(input), { ok: true, enabled: true });
  assert.deepEqual(await handler.getDriftNotificationSetting(input), { ok: true, canManage: true, enabled: true });
  assert.equal((await handler.setDriftNotificationSetting({ ...input, context: {} })).ok, false);
  assert.equal((await handler.setDriftNotificationSetting({ ...input, payload: { projectKey, enabled: 'false' } })).ok, false);
  assert.deepEqual(await handler.setDriftNotificationSetting({
    ...input, payload: { projectKey, enabled: false }
  }), { ok: true, enabled: false });
  assert.equal(notifyRequests().length, 0);
});

test('a text edit in a project with nothing to watch logs only the key and the reason it was skipped', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  kvsMemory.set(radarKey, { projectKey, version: 1, radar: { findings: { [findingId]: { firstSeenAt: oldTime } }, drifts: {} } });
  assert.deepEqual(await onIssueUpdated(edit()), { checked: 0, resolved: 0, opened: 0 });
  assert.equal(requests.length, 0);
  const logs = info.mock.calls.map(({ arguments: args }) => args.join(' '));
  assert.deepEqual(logs, ['Decision Drift Radar issue update skipped: DD-1, no open drift or watched decision']);
  for (const line of logs) for (const secret of [phrase, title]) assert.ok(!line.includes(secret));
});

test('recipients are the assignee and reporter once each, and an issue with neither sends nothing', async () => {
  kvsMemory.set(settingKey, true);
  people = { assignee: { accountId: 'acct-a' }, reporter: { accountId: 'acct-b' } };
  await onIssueUpdated(created());
  assert.deepEqual(JSON.parse(notifyRequests()[0].options.body).to, { users: [{ accountId: 'acct-a' }, { accountId: 'acct-b' }] });

  kvsMemory.clear();
  requests.length = 0;
  kvsMemory.set(settingKey, true);
  kvsMemory.set(radarKey, { projectKey, version: 1, radar: { findings: { [findingId]: { firstSeenAt: oldTime, watch: { phrase } } }, drifts: {} } });
  people = { assignee: null, reporter: null };
  await onIssueUpdated(created());
  assert.equal(notifyRequests().length, 0);
  assert.equal(drift().status, 'open');
});
