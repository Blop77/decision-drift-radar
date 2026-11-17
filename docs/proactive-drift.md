# Design: proactive drift detection

Phase 1 is in the app. Phase 2 adds the opt-in below. Its regression tests use mocked Jira and Forge storage.

**Verified live on production (3.16.0, 16 November 2026),** in a private test space whose only member is the site owner:
- Creating an issue that uses wording a known decision replaced opened a drift without a scan, shown as found "when the issue was created".
- With notifications on, the issue's assignee and reporter (one person) received exactly one Jira email.
- The email had the fixed subject and the sentence "A recorded decision may affect this issue. Open Decision Drift Radar on the issue to check the evidence you have access to.", with no decision details.

**What the live tests found and fixed:**
- **Duplicate email. Fixed.** The first production test (3.15.0) sent two emails to a person who was both assignee and reporter, because the request named both roles. Recipients are now the unique account IDs of the assignee and reporter.
- **Missing message. Fixed.** The fixed sentence was sent only as plain text, and the email client showed the HTML part. It is now sent as HTML too.
- **Outgoing mail.** Jira sends the email only if the site's outgoing mail is enabled. On a site with mail disabled, Jira answers `403`: the drift is still recorded, the log holds only the issue key and status, and there's no retry.
- **New projects.** Right after a project was created, Jira didn't deliver its issue events to the app for a while: on both test sites, edits and creations in the first minutes never reached the trigger, while later ones did. Before the catch-up below, only a later scan found those drifts, and no notification was sent. The trigger logs a key-only line when it skips an edit because the project has nothing to check, so a skipped event and an undelivered one can be told apart.
- **Scheduled catch-up (added after those tests).** A `scheduledTrigger` runs every five minutes. It reads a small per-project marker list (projects whose radar has a watched phrase or an open drift), searches each for issues updated in the last 10–60 minutes, and runs the same per-issue check as the trigger. The check is safe to repeat, so overlapping windows change nothing and a drift is still notified at most once. An event Jira never delivers is now caught within about five minutes.

## Problem

Radar finds new drift only when someone runs a scan, opens an issue panel or asks Rovo. Nothing happens when an issue is created, or edited to start using wording a decision replaced. The 2025 Codegeist winners all did something on the user's behalf; Radar only waits to be asked.

## Before Phase 1

- **The radar record** (one per project, versioned custom entity, `src/resolvers/drift.js`) stores:
  - `findings[id] = { firstSeenAt }`;
  - `drifts[findingId:issueKey] = { phrase, status, firstSeenAt, resolvedAt?, resolvedBy?, observedAt }`.
- **Scans** (`applyScan`) open, confirm, reopen and resolve drifts from what the signed-in user can see.
- **The trigger** `drift-watch` (`avi:jira:updated:issue`, `ignoreSelf`) can only mark an *open* drift resolved:
  - it reads that one issue as the app;
  - it stores only the resolution and observation times;
  - it never adds findings or drifts.
- **Display** (`describeFindings`) shows drift history only for findings and issues in the viewer's own scan.

## Design

Phase 1 records drift on issue creation and edits. Phase 2 lets a project admin opt in to Jira notifications.

### Phase 1: detect and record on create or edit (recommended)

1. **Remember what each decision replaced.** When a scan sees a finding whose wording names what it replaced (`extractChange(summary)`, giving `from` or `removed`), store it on the finding:

   ```
   findings[id] = { firstSeenAt, watch: { phrase: "on the same day", replacement: "after the website update" } }
   ```

   These short phrases come from the decision text and are the same kind of data already stored on drifts. No issue text is stored.

2. **Watch creation as well as edits.** Add `avi:jira:created:issue` to the existing `drift-watch` trigger's `events`. The existing `avi:jira:updated:issue` handling still applies only when `summary` or `description` changed. The trigger then:
   - reads that one issue as the app (`summary`, `description`), as it already does;
   - for every watched finding in the issue's project, checks whether the issue contains a watched phrase (`issueStillMentions`), and whether a drift for that finding and issue already exists;
   - if it contains the phrase and no drift exists, adds `{ status: 'open', foundBy: 'issue-create' | 'issue-edit', firstSeenAt: now, observedAt }`;
   - if a resolved drift exists and the phrase is back, reopens it with `reopenedBy: 'issue-edit'`, keeping its original date (the rule scans already follow);
   - keeps resolving open drifts exactly as today.

   It uses the same `updateRadar` versioned write and `observedAt` ordering, so it is safe against concurrent scans (the cases in `test/drift-concurrency.test.ts`). Logs carry only the issue key and counts.

3. **Show it without new access risk.** Nothing is shown at event time. The next scan or issue panel opened by a viewer shows the drift only if *that viewer's* scan returns the decision and the issue (`describeFindings` already enforces this):
   - **Drift line:** "Drifting since 15/11/2026, when the issue was edited: the issue still says “on the same day”." For creation, it says "when the issue was created".
   - **Radar summary:** add "N new drifts since your last visit", counted from `firstSeenAt > previousVisitAt` and limited to what the viewer can see.
   - **Rovo:** `findProjectDecisions` reports the same "found when the issue was edited".

**What Phase 1 honestly adds:**
- Drift is found at the moment the issue changes, with an exact date and cause.
- The project page can say what changed since your last visit.
- Drift on a brand-new issue is caught even before anyone scans.

**What it doesn't add:** nobody is told until they open Radar. That gap is Phase 2.

### Phase 2: optional notification

When the trigger opens a drift, send a Jira notification to the issue's assignee and reporter through Jira's own notify API (`POST /rest/api/3/issue/{key}/notify`, existing `write:jira-work` scope, no egress). The text is the generic note:

> "A recorded decision may affect this issue. Open Decision Drift Radar on the issue to check the evidence you have access to."

It contains no quote, page title or link to the source.

**Guardrails:**
- **Off by default.** Only someone with *Administer projects* permission can turn it on, from the project page. The setting is stored per project.
- **Delivery:** the trigger saves the drift first. It never sends on a reopen, a scan or a self-generated event. Jira's `204` means queued. It is recorded on the drift as `notifiedAt`.
- **Rate limits:** one attempt per drift and at most 20 per project per UTC day. A conditional Forge counter reserves a daily slot before a send. A durable marker prevents another attempt if the drift history is pruned. Failed or uncertain requests are not retried.
- **Privacy:** recipients might learn that a decision exists even when they cannot read it. The payload carries only the issue key and fixed message text. Evidence access is checked when the recipient opens the panel.

## Versioning and permissions

- **No new scopes:** both events need `read:jira-work`, which the app already has.
- **Minor version, confirmed.** Adding the `created` event and the Phase 2 code each deployed to development as a minor version, so existing installations update without a reinstall.

## Limits (to state in the docs)

- It only watches decisions a scan has already found; the trigger never discovers decisions.
- It only catches wording a decision explicitly names as replaced, the same rule as scans.
- It sees only issue creation and summary or description edits. Comments are not watched.
- Up to 300 watched findings per project (the existing radar cap). It checks phrases only, with no AI call.

## Tests

1. A created issue containing a watched phrase opens a drift, with `foundBy: 'issue-create'`.
2. An edit that adds the phrase opens a drift (`issue-edit`), and an edit that removes it resolves it (existing behaviour).
3. A resolved drift whose phrase returns reopens with its original `firstSeenAt`.
4. No drift is opened for a project with no watched findings, or for an issue in another project.
5. Self-generated events are ignored, and edits to other fields are ignored.
6. Trigger and scan race in both orders, and the result stays consistent (extend `drift-concurrency.test.ts`).
7. A viewer whose scan doesn't return the decision sees nothing, and the summary count excludes it.
8. Logs contain no issue or decision text.

Every change also has to pass the usual checks: `npm test`, the benchmark (unchanged), `forge lint` with 0 issues, and `git diff --check`.

## Live verification (needs the user's approval)

On development:
1. Edit one MC test issue, chosen with the user, to add a watched phrase.
2. Leave Radar closed for about 4 minutes, then open the project page and the issue panel.
3. Expect "found when the issue was edited" and "1 new drift since your last visit".
4. Restore the issue exactly, by fingerprint as with MC-10.

To test creation, creating a throwaway issue is a live write and would need its own approval and clean-up plan.

## Effect on the video and Devpost

- **New UI text:** "when the issue was edited", and the new-drifts count. The v8 video (2:37) doesn't show either, so nothing in it becomes wrong. A re-record after the freeze could show it.
- **Text to update:** the Devpost description and the "What's next" item "Discover new drift between scans" move from "next" to "done".

## Estimate

- **Phase 1:** about 3–4 days, including tests and the live check.
- **Phase 2:** about 2–3 more days, including the admin setting and docs.
