/**
 * Single sentences and the verdict the built-in rules should give them. `null` means "not a
 * finding". Each case names the rule it pins down.
 */
import type { DecisionKind } from '../decisionTypes';

export interface SentenceCase {
  rule: string;
  text: string;
  /** Lines before the sentence, for headings and transcript replies. */
  before?: string[];
  after?: string[];
  title?: string;
  expect: DecisionKind | null;
}

export const sentenceCases: SentenceCase[] = [
  { rule: 'decision label', text: 'Decision: Weekly reports go out on Thursdays.', expect: 'decision' },
  { rule: 'label with a qualifier', text: 'Decided in the retro: on-call swaps need a manager.', expect: 'decision' },
  { rule: 'outcome label', text: 'Outcome: the vendor contract renews for one year.', expect: 'decision' },
  { rule: 'labels are never downgraded', text: 'Decision: we will not decide on pricing until March.', expect: 'decision' },
  { rule: 'team commitment', text: 'We agreed to freeze the API on 1 December.', expect: 'decision' },
  { rule: 'decided against', text: 'The team decided against a second data centre.', expect: 'decision' },
  { rule: 'consensus', text: 'There was consensus to retire the old dashboard.', expect: 'decision' },
  { rule: 'approval', text: 'The travel budget was approved by finance.', expect: 'decision' },
  { rule: 'list item under a decisions heading', before: ['## Outcomes'], text: '- Keep the staging site behind single sign-on.', expect: 'decision' },
  { rule: 'what was agreed is not itself a decision', text: 'This page records what the team agreed in the review.', expect: null },
  { rule: 'reversed decision', text: 'The decision to move to monthly billing was reversed.', expect: null },
  { rule: 'withdrawn approval', text: 'The approval was withdrawn after the audit.', expect: null },
  { rule: 'negated', text: 'We did not agree on a launch date.', expect: null },
  { rule: 'conditional', text: 'Once we agree on scope, design can start.', expect: null },
  { rule: 'future decision', text: 'We will decide next week which vendor to use.', expect: null },
  { rule: 'pending approval', text: 'The rollout is waiting for security approval.', expect: null },
  { rule: 'hedged view on a transcript line', text: 'josh: I think we agreed to ship it.', expect: 'proposal' },
  { rule: 'not decided yet', text: 'We have not decided whether to hire a contractor.', expect: 'open_question' },
  { rule: 'open question label', text: 'Open question: who owns the status page?', expect: 'open_question' },
  { rule: 'unanswered question', text: 'Should we keep the legacy export?', expect: 'open_question' },
  { rule: 'question answered on the next line', text: 'sam: Should we keep the legacy export?', after: ['ria: Yes, for one more quarter.'], expect: null },
  { rule: 'a question that does not ask what to do', text: 'Anyone else hungry?', expect: null },
  { rule: 'suggestion', text: 'We should add a retry budget to the importer.', expect: 'proposal' },
  { rule: 'proposal wording', text: 'I propose that support handles refunds under 50 euros.', expect: 'proposal' },
  { rule: 'a stated need is not a proposal', text: 'We need a marketing asset for the analyst showcase.', expect: null },
  { rule: 'a hedged need is a proposal', text: 'I feel like we need a design meeting about this.', expect: 'proposal' },
  { rule: 'reference line', text: 'Attendees: Sam, Ria, Josh.', expect: null },
  { rule: 'plain statement', text: 'The build took eleven minutes today.', expect: null },
  { rule: 'typographic apostrophe', text: 'We’ve agreed to rename the service.', expect: 'decision' }
];

/** Sentences the change rules should read, and what they should find. */
export const changeCases: Array<{ text: string; expect: { from?: string; to?: string; removed?: string } | undefined }> = [
  { text: 'Use the new intake form instead of the shared spreadsheet.', expect: { from: 'shared spreadsheet', to: 'new intake form' } },
  { text: 'Releases ship on Tuesdays rather than on Fridays.', expect: { from: 'on Fridays', to: 'on Tuesdays' } },
  { text: 'Replace the nightly export with a live sync.', expect: { from: 'nightly export', to: 'live sync' } },
  { text: 'We will switch from Jenkins to hosted pipelines.', expect: { from: 'Jenkins', to: 'hosted pipelines' } },
  { text: 'Support no longer answers phone calls after 6 pm.', expect: { removed: 'answers phone calls' } },
  { text: 'Stop sending the weekly digest.', expect: { removed: 'sending the weekly digest' } },
  { text: 'Decision: Product documentation is out of scope for launch week.', expect: { removed: 'Product documentation' } },
  { text: 'Fraud review covers risky orders only, instead of all international orders.', expect: { from: 'international orders', to: 'risky orders' } },
  { text: 'We decided to ship it.', expect: undefined }
];
