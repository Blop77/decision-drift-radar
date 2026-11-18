/**
 * Data shapes shared by the extraction module, the Forge resolvers and the UI.
 * Stored records (reviews, notes, drift history) refer to candidates by `id`, so these shapes
 * are a stable contract: change them only together with everything that reads them.
 */

/** Where a piece of text came from. */
export type SourceType = 'confluence_page' | 'jira_issue' | 'jira_comment';

/** One readable text the scan collected: a Confluence page, an issue description or a comment. */
export interface SourceRecord {
  id: string;
  type: SourceType;
  title: string;
  url: string;
  /** Plain text: one paragraph per line, `## ` for headings, `- ` for list items. */
  text: string;
  projectKey: string;
  /** ISO 8601 time of the last edit. */
  updatedAt: string;
  author?: string;
  /** How the source was reached when not by key search, for example through Teamwork Graph. */
  via?: string;
}

/** A Jira issue a finding may affect. */
export interface IssueRecord {
  id: string;
  key: string;
  title: string;
  description?: string;
  projectKey: string;
  status?: string;
  labels?: string[];
  updatedAt: string;
}

export type DecisionKind = 'decision' | 'proposal' | 'open_question';

/** The exact text a finding rests on: `text.slice(start, end) === quote` in its source. */
export interface EvidenceSpan {
  quote: string;
  start: number;
  end: number;
}

/** A source as attached to a finding, without its text. */
export interface CandidateSource {
  id: string;
  type: SourceType;
  title: string;
  url: string;
  projectKey: string;
  updatedAt: string;
  author?: string;
  via?: string;
}

/** An issue a finding may affect, with a 0-1 strength and the plain reasons behind it. */
export interface AffectedIssue {
  issueKey: string;
  relevance: number;
  /** `outdated`: the issue still uses wording the decision replaced. `replacement-found`: it now uses the new wording. */
  wordingStatus?: 'outdated' | 'replacement-found';
  outdatedWording?: string;
  reasons: string[];
}

/** One finding: a decision, proposal or open question, with its evidence and the issues it may affect. */
export interface DecisionCandidate {
  /** Stable for the same source and wording, so reviews and history survive rescans. */
  id: string;
  kind: DecisionKind;
  summary: string;
  evidence: EvidenceSpan;
  source: CandidateSource;
  /** 0-1 strength of the wording signals; not a probability. */
  confidence: number;
  confidenceReasons: string[];
  affectedIssues: AffectedIssue[];
}

export interface ExtractionInput {
  sources: SourceRecord[];
  issues: IssueRecord[];
  /** At most this many candidates are returned (default 50). */
  maxCandidates?: number;
}

export type ExtractionWarningCode =
  | 'invalid_input'
  | 'empty_input'
  | 'invalid_source'
  | 'invalid_issue'
  | 'duplicate_source'
  | 'duplicate_issue'
  | 'invalid_timestamp'
  | 'invalid_option'
  | 'candidates_truncated';

/** Something in the input was skipped or adjusted; extraction never throws on bad records. */
export interface ExtractionWarning {
  code: ExtractionWarningCode;
  message: string;
  recordId?: string;
}

export interface ExtractionResult {
  candidates: DecisionCandidate[];
  warnings: ExtractionWarning[];
}

/** The verdict on one sentence: its kind, a 0-1 strength and the plain reasons. */
export interface SentenceClassification {
  kind: DecisionKind;
  confidence: number;
  reasons: string[];
}

/** What the classifier knows about a sentence besides its words. */
export interface SentenceContext {
  sourceType: SourceType;
  sourceTitle: string;
  /** The sentence sits under a heading such as "Decisions" or "Outcomes". */
  underDecisionHeading: boolean;
  /** The sentence is a list item under such a heading. */
  decisionListItem?: boolean;
  /** A question on a transcript line that another speaker replies to on the next line. */
  answeredByReply?: boolean;
  /** The sentence comes right after a bare "Conclusion." or "Outcome:" marker. */
  followsOutcomeMarker?: boolean;
}

export type SentenceClassifier = (sentence: string, context: SentenceContext) => SentenceClassification | null;

export interface ExtractionOptions {
  /** Replaces the built-in wording rules; used by tests. */
  classifier?: SentenceClassifier;
}
