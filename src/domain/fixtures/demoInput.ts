/**
 * A fictional field-service team (project FS) for the domain checks. One record per wording rule,
 * so a change to the rules shows up as a change in `expectedDemoOutput.json`.
 */
import type { ExtractionInput, IssueRecord, SourceRecord } from '../decisionTypes';

const page = (id: string, title: string, lines: string[], extra: Partial<SourceRecord> = {}): SourceRecord => ({
  id,
  type: 'confluence_page',
  title,
  url: `https://example.atlassian.net/wiki/spaces/FS/pages/${id}`,
  projectKey: 'FS',
  updatedAt: '2026-11-03T09:00:00Z',
  author: 'Field Ops',
  text: lines.join('\n'),
  ...extra
});

const issue = (n: number, title: string, description: string, status = 'To Do'): IssueRecord => ({
  id: `fs-${n}`,
  key: `FS-${n}`,
  title,
  description,
  projectKey: 'FS',
  status,
  labels: [],
  updatedAt: '2026-11-01T09:00:00Z'
});

export const demoSources: SourceRecord[] = [
  page('fs-review', 'Route planning review: decisions', [
    'Notes from the route planning review on 2 November.',
    '## Decisions',
    '- Decision: Dispatch assigns jobs by postcode instead of by technician seniority.',
    '- Technicians carry one shared parts kit per van.',
    '- Open question: Do contractors use the same mobile app?',
    '## Notes',
    'We should pilot the new route optimiser in the northern region first.',
    'The decision to outsource weekend callouts was reversed after the cost review.'
  ]),
  page('fs-standup', 'Field ops standup', [
    'amira: Should we keep paper job sheets as a backup?',
    'dev: Only for sites with no signal, see FS-14.',
    'amira: How do we price emergency callouts?',
    'dev: I think we agreed to drop the night surcharge.',
    'We decided to send customer arrival texts 30 minutes ahead rather than the evening before.',
    'Once finance agrees, we will move invoices from the shared inbox to the billing portal.',
    'We have not decided whether apprentices can close jobs alone.',
    'Attendees: Amira, Dev, Ruth.'
  ]),
  {
    id: 'fs-comment-1',
    type: 'jira_comment',
    title: 'Comment on FS-12 by Ruth',
    url: 'https://example.atlassian.net/browse/FS-12?focusedCommentId=1',
    projectKey: 'FS',
    updatedAt: '2026-11-04T15:00:00Z',
    author: 'Ruth',
    text: 'Agreed: we no longer print delivery notes on site. Photos in the app are the proof of delivery.'
  }
];

export const demoIssues: IssueRecord[] = [
  issue(10, 'Job assignment rules', 'Assign each new job by technician seniority, then by distance.', 'In Progress'),
  issue(11, 'Van stock list', 'Every technician keeps a personal parts kit; restock weekly.'),
  issue(12, 'Proof of delivery', 'Print delivery notes on site and ask the customer to sign them.'),
  issue(13, 'Customer arrival texts', 'Send arrival texts the evening before each visit.'),
  issue(14, 'Offline job sheets', 'Paper job sheets for sites with no mobile signal.'),
  issue(15, 'Postcode dispatch', 'Dispatch assigns jobs by postcode from the planning board.', 'Done'),
  issue(16, 'Office plants', 'Water the plants in the depot kitchen.')
];

export const demoInput: ExtractionInput = { sources: demoSources, issues: demoIssues };
