import api, { route } from '@forge/api';
import { Filter, FilterConditions, kvs } from '@forge/kvs';

const MAX_DAILY_NOTIFICATIONS = 20;
// Reuse the versioned entity with a separate key prefix. No new storage schema is needed.
const COUNTER_ENTITY = 'radar-state';
const COUNTER_TTL = { unit: 'DAYS', value: 2 };
const settingKey = (projectKey) => `drift-notifications:${projectKey}`;
const utcDay = () => new Date().toISOString().slice(0, 10);
const NOTICE = 'A recorded decision may affect this issue. Open Decision Drift Radar on the issue to check the evidence you have access to.';

export async function canManageDriftNotifications(projectKey) {
  const permissions = 'ADMINISTER_PROJECTS';
  const response = await api.asUser().requestJira(route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=${permissions}`);
  return response.ok && (await response.json())?.permissions?.ADMINISTER_PROJECTS?.havePermission === true;
}

export async function driftNotificationsEnabled(projectKey) {
  return (await kvs.get(settingKey(projectKey))) === true;
}

export function setDriftNotificationsEnabled(projectKey, enabled) {
  return kvs.set(settingKey(projectKey), enabled);
}

/** Reserve an attempt before calling Jira, even when several triggers are running at once. */
async function reserveDailyNotification(projectKey, day) {
  const key = `drift-notification-count:${projectKey}:${day}`;
  const entity = kvs.entity(COUNTER_ENTITY);
  for (let attempt = 0; attempt < MAX_DAILY_NOTIFICATIONS; attempt++) {
    const current = await entity.get(key);
    const count = current?.version ?? 0;
    if (count >= MAX_DAILY_NOTIFICATIONS) return false;

    const next = { projectKey, version: count + 1, radar: {}, updatedAt: new Date().toISOString() };
    try {
      if (current) {
        await kvs.transact().set(key, next, {
          entityName: COUNTER_ENTITY,
          conditions: new Filter().and('version', FilterConditions.equalTo(count))
        }, { ttl: COUNTER_TTL }).execute();
      } else {
        await entity.set(key, next, { keyPolicy: 'FAIL_IF_EXISTS', ttl: COUNTER_TTL });
      }
      return true;
    } catch (error) {
      // An ambiguous write may have consumed a slot. Never roll back a counter or send without one.
      if (!((await entity.get(key))?.version > count)) throw error;
    }
  }
  return false;
}

/** Try once per new drift. Jira can queue a request even if the caller loses the response. */
export async function notifyNewDrifts(projectKey, issueKey, driftIds, recipients = []) {
  const notified = new Map();
  if (!driftIds.length || !recipients.length) return notified;

  try {
    if (!(await driftNotificationsEnabled(projectKey))) return notified;

    for (const id of driftIds) {
      const receiptKey = `drift-notification-attempt:${projectKey}:${id}`;
      if (await kvs.get(receiptKey)) continue;
      const day = utcDay();
      if (!(await reserveDailyNotification(projectKey, day))) break;
      if (!(await driftNotificationsEnabled(projectKey)) || utcDay() !== day) break;

      // The bounded radar can prune old drifts. A durable attempt marker prevents sending again.
      try {
        await kvs.set(receiptKey, true, { keyPolicy: 'FAIL_IF_EXISTS' });
      } catch (error) {
        if (await kvs.get(receiptKey)) continue;
        throw error;
      }
      if (utcDay() !== day) break;

      try {
        const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // The issue's assignee and reporter, each listed once.
            to: { users: recipients.map((accountId) => ({ accountId })) },
            subject: `Decision Drift Radar: a recorded decision may affect ${issueKey}`,
            textBody: NOTICE,
            // Email clients show the HTML part, so the fixed text must be there too.
            htmlBody: `<p>${NOTICE}</p>`
          })
        });
        if (response.status === 204) {
          notified.set(id, new Date().toISOString());
          console.info(`Decision Drift Radar notification: ${issueKey}, HTTP ${response.status}`);
        } else {
          console.warn(`Decision Drift Radar notification: ${issueKey}, HTTP ${response.status}`);
        }
      } catch {
        console.warn(`Decision Drift Radar notification: ${issueKey}, HTTP status unavailable`);
      }
    }
  } catch {
    console.warn(`Decision Drift Radar notification: ${issueKey}, HTTP status unavailable`);
  }
  return notified;
}
