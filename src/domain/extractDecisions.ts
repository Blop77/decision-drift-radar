/**
 * Finds decisions, proposals and open questions in plain source text, with the exact sentence
 * each rests on and the Jira issues it may affect. Pure and deterministic: no network, no clock,
 * and bad records become warnings instead of errors.
 */
import type {
  CandidateSource,
  DecisionCandidate,
  DecisionKind,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  ExtractionWarning,
  IssueRecord,
  SentenceClassification,
  SentenceClassifier,
  SentenceContext,
  SourceRecord,
  SourceType
} from './decisionTypes';
import { indexIssues, matchIssues, type IssueIndex } from './matchIssues';
import { comparable, plain, sentencesOf, speakerOf, type Sentence } from './text';

export { sourceLines } from './text';
export type { SourceLine } from './text';

/** Quotes, and so findings, are at most this many characters. */
export const MAX_QUOTE_LENGTH = 280;
const DEFAULT_MAX_CANDIDATES = 50;
const SOURCE_TYPES: SourceType[] = ['confluence_page', 'jira_issue', 'jira_comment'];
const KINDS: DecisionKind[] = ['decision', 'proposal', 'open_question'];

// ---------------------------------------------------------------------------
// Stable ids
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a over UTF-16 code units, from the given offset basis. */
function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The same source and wording always give the same id, wherever the sentence moves on the page,
 * so reviews, notes and drift history stay attached across rescans and edits elsewhere.
 */
export function stableId(sourceId: string, summary: string): string {
  const key = `${sourceId}␟${summary.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  return `dc_${fnv1a(key, 0x811c9dc5)}${fnv1a(key, 0x01234567)}`;
}

// ---------------------------------------------------------------------------
// Wording rules
// ---------------------------------------------------------------------------

// "Decision:", "Agreed:", also with a short qualifier ("Decided in standup:").
const DECISION_LABEL = /^(decision|decided|agreed|resolved|resolution|conclusion|outcome|consensus)s?\b([^:\n]{0,24}):\s*(?=\S)/i;
/** A bare "Conclusion." or "Outcome:" that introduces the decision in the sentence after it. */
const OUTCOME_MARKER = /^(?:conclusion|conclusions|outcome|outcomes|decision|decisions|resolution|consensus)\s*[.:]$/i;
const QUESTION_LABEL = /^(open question|question)s?\s*:\s*/i;
const PROPOSAL_LABEL = /^(proposal|proposed|suggestion)s?\s*:\s*/i;
/** Labels that open reference lines rather than findings. */
const REFERENCE_LABEL = /^(attendees|participants|present|absent|apologies|agenda|date|time|owner|owners|source|sources|see also|related|links?|location|notes? by|minutes by|tracking comment|initiating comment)\s*:/i;

const DECISION_HEADING = /\b(decision|decisions|decided|outcome|outcomes|agreed|agreements?|resolution|resolutions)\b/i;
const QUESTION_HEADING = /\b(open questions?|questions|unresolved|to decide)\b/i;
const DECISION_TITLE = /\b(decision|decisions|adr|outcome|outcomes|resolution|agreement|agreements)\b/i;

const REVERSED = /\b(?:was|were|has been|have been|is|are|got|been)\s+(?:later\s+|since\s+)?(?:reversed|withdrawn|rescinded|revoked|overturned|cancelled|canceled|undone)\b|\b(?:reversed|withdrew|rescinded|revoked|overturned)\s+(?:the|our|that|this)\s+(?:earlier\s+|previous\s+)?decision\b/;
const NEGATED = /\b(?:not|never|no one|nobody|didn't|did not|haven't|have not|hasn't|has not|wasn't|was not|weren't|were not|isn't|is not|aren't|are not|couldn't|could not|can't|cannot)\s+(?:yet\s+|really\s+|fully\s+|actually\s+|formally\s+)?(?:been\s+)?(?:agree|agreed|decide|decided|approve|approved|settle|settled|reach(?:ed)? (?:a )?(?:decision|consensus|agreement))\b|\bno (?:decision|agreement|consensus)\b/;
const UNDECIDED = /\b(?:not|never|haven't|have not|hasn't|has not)\s+(?:yet\s+)?(?:decided|agreed|settled)\s+(?:on\s+)?(?:whether|if|how|when|which|what|who|where)\b|\b(?:still\s+)?(?:undecided|to be decided|tbd)\b/;
const CONDITIONAL = /\b(?:once|if|when|until|unless|after|before)\s+(?:we|the team|everyone|they|leadership|it|this)\b[^.?!]{0,40}\b(?:agree|agreed|agrees|decide|decided|decides|approve|approved|approves|sign(?:s|ed)? off)\b|\b(?:will|shall|going to|need to|needs to|have to|has to|must|should|plan to|aim to|hope to|try to|want to)\s+(?:\w+\s+){0,2}(?:decide|agree|approve|vote)\b|\b(?:decide|agree)\s+(?:on\s+\w+\s+)?(?:next|later|tomorrow|soon)\b|\b(?:to be|be|pending|awaiting|waiting for|needs?|subject to)\s+(?:\w+\s+){0,2}(?:approved|approval|sign-?off)\b/;
const HEDGED = /^(?:i think|i believe|i guess|i feel|i'm not sure|i am not sure|maybe|perhaps|probably|i assume|if i remember|iirc|as far as i know|afaik)\b/;

const COMMITMENT: Array<[RegExp, string]> = [
  [/\b(?:agreed|decided|resolved)\s+(?:to|that|on|upon|against|we|it)\b/, 'Says the team agreed or decided'],
  [/^(?:we\s+)?(?:decide|agree)\s+(?:to|that|on|against)\b/, 'Says the team agreed or decided'],
  [/\b(?:it|this|that)\s+(?:was|has been|is)\s+(?:agreed|decided|resolved)\b/, 'Says the team agreed or decided'],
  [/\b(?:we|the team|the group)\s+(?:settled on|settled that|opted for|opted to|chose to|committed to|concluded that)\b/, 'Says the team agreed or decided'],
  [/\b(?:general|broad|full|unanimous)\s+agreement\b|\b(?:there was|we reached|reached)\s+(?:a\s+)?consensus\b|\bconsensus\s+(?:is|was)\s+to\b/, 'Records agreement or consensus'],
  [/\b(?:was|were|has been|have been|is|got)\s+(?:already\s+|now\s+|formally\s+|officially\s+|then\s+)?approved\b|^approved\b|\b(?:we|leadership|the board|the committee|\w+)\s+approved\s+(?:the|a|an|our|this|that)\b|\bwe(?:'re| are)\s+approving\b|\b(?:and \w+|we|everyone|all|both|the team|the group)\s+approved?\b(?!\s+of)/, 'Records an approval'],
  [/\b(?:the\s+)?(?:group|team|everyone|all|committee)\s+agrees?\b(?!\s+(?:on\s+)?(?:whether|if))/, 'Records agreement or consensus'],
  [/\b(?:nobody|no one)\s+(?:has\s+(?:an?\s+)?appetite|objects|objected)\b|\bno objections?\b/, 'Records agreement or consensus']
];
const OUTCOME_WILL = /^(?:so\s+|then\s+|therefore\s+)?(?:we|the team)\s+(?:will|'ll|are going to|are)\s+(?!decide|agree|discuss|talk|think|look|meet|review|consider|need|check|see|try)\w+/;

const PROPOSAL: Array<[RegExp, string]> = [
  [/^(?:proposal|rfc)\s+(?:to|for)\b/, 'Names a proposal that has not been decided'],
  [/^(?!if\b|in case\b|when\b|unless\b).*\b(?:we|they|the team|someone|somebody)\s+(?:should|could|might want to|ought to)\b(?!\s+(?:decide|agree|be able))|\byou\s+should\b/, 'Suggests a change but does not record a decision'],
  [/\b(?:current|the|our|a|one)\s+proposal\s+(?:is\s+)?to\b|\b(?:can|could)\s+(?:this|that|it)\s+be\s+(?:added|changed|included|moved)\b/, 'Proposes a change but does not record a decision'],
  [/\b(?:i think|i feel|i believe)\s+(?:this|that|it)\s+(?:warrants|needs|deserves)\b|\b(?:i'd|i would|would)\s+like\s+to\s+see\b|\b(?:i'm\s+|i am\s+)?inclined\s+to\b|\bone\s+(?:thought|idea|option)\s+is\b/, 'Suggests a change but does not record a decision'],
  [/\b(?:i|we)\s+(?:propose|suggest|recommend)\b|\b(?:proposal|suggestion)\s+(?:is|was)\s+to\b|\bproposed\s+(?:that|to|we)\b/, 'Proposes a change but does not record a decision'],
  [/\bhow about\b|\blet'?s\s+(?:consider|think about|look at|try)\b|\bwhat if we\b/, 'Suggests a change but does not record a decision'],
  // "We need a marketing asset…" in an issue states a requirement; hedged, it puts an idea to the group.
  [/\b(?:i think|i feel like|i guess|maybe|perhaps)\s+we\s+(?:need|might need|may need)\s+(?:a|an|to)\b|\bwe\s+(?:can|could)\s+just\b/, 'Suggests a change but does not record a decision'],
  [/\bwe(?:'re| are)\s+thinking\s+(?:that|of|about)\b|\b(?:may|might|would)\s+be\s+(?:a\s+)?better\b/, 'Weighs an option but does not record a decision']
];
const ASK_WORD = /^(?:but\s+|so\s+|and\s+)?(?:what about|should|shall|do|does|did|can|could|will|would|are|is|was|were|how|what|which|when|who|where|why)\b/;
/** The question's own clause asks what to do ("…, but would it be enough?"). */
const asks = (t: string) => t.split(/\s+/).length >= 4 && (ASK_WORD.test(t) || ASK_WORD.test(t.split(/[,;]\s*/).pop() ?? ''));

const labelReason = (label: string) => {
  const word = `${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()}`;
  return `Starts with ${/^[AEIOU]/.test(word) ? 'an' : 'a'} "${word}:" label`;
};

/** Drops a transcript speaker ("josh: ") so the wording rules see what was said. */
function spoken(sentence: string): { text: string; hasSpeaker: boolean } {
  const speaker = speakerOf(sentence);
  if (!speaker || DECISION_LABEL.test(sentence) || QUESTION_LABEL.test(sentence) || PROPOSAL_LABEL.test(sentence)) {
    return { text: sentence, hasSpeaker: false };
  }
  return { text: sentence.slice(sentence.indexOf(':') + 1).trim(), hasSpeaker: true };
}

/**
 * The built-in wording rules. Labels win; then reversals, negations, conditions and hedges rule
 * a sentence out; then commitment wording, questions and suggestions are recognised.
 */
export const defaultClassifier: SentenceClassifier = (sentence, context) => {
  const raw = plain(sentence).trim();
  if (!raw || REFERENCE_LABEL.test(raw)) return null;

  const label = raw.match(DECISION_LABEL);
  if (label) return { kind: 'decision', confidence: 0.85, reasons: [labelReason(label[1])] };
  if (QUESTION_LABEL.test(raw)) return { kind: 'open_question', confidence: 0.85, reasons: ['Starts with an "Open question:" label'] };
  if (PROPOSAL_LABEL.test(raw)) return { kind: 'proposal', confidence: 0.75, reasons: ['Starts with a "Proposal:" label'] };

  const { text, hasSpeaker } = spoken(raw);
  const t = text.toLowerCase();

  if (REVERSED.test(t)) return null;
  if (UNDECIDED.test(t)) return { kind: 'open_question', confidence: 0.6, reasons: ['Says this has not been decided yet'] };
  if (t.endsWith('?')) {
    if (context.answeredByReply) return null;
    if (!asks(t)) return null;
    return { kind: 'open_question', confidence: 0.55, reasons: ['Asks what to do, and the next line does not answer it'] };
  }
  if (NEGATED.test(t) || CONDITIONAL.test(t)) return null;

  // "group agrees: …" looks like a speaker label; check the agreement wording before it too.
  const commitment = COMMITMENT.find(([pattern]) => pattern.test(t) || (hasSpeaker && pattern.test(raw.toLowerCase())));
  if (commitment) {
    if (hasSpeaker && HEDGED.test(t)) {
      return { kind: 'proposal', confidence: 0.45, reasons: ['A personal view on a transcript line, not a recorded decision'] };
    }
    return { kind: 'decision', confidence: 0.7, reasons: [commitment[1]] };
  }
  if (context.followsOutcomeMarker && !t.endsWith('?')) {
    return { kind: 'decision', confidence: 0.7, reasons: ['Follows a "Conclusion" or "Outcome" marker'] };
  }
  if (context.decisionListItem) {
    return { kind: 'decision', confidence: 0.7, reasons: ['A list item recorded as an outcome'] };
  }
  if ((context.underDecisionHeading || DECISION_TITLE.test(context.sourceTitle)) && OUTCOME_WILL.test(t)) {
    return { kind: 'decision', confidence: 0.6, reasons: ['States what the team will do, in a decision record'] };
  }

  if (t.endsWith(':')) return null; // a suggestion that introduces a list; the items carry the content
  const proposal = PROPOSAL.find(([pattern]) => pattern.test(t));
  if (proposal) return { kind: 'proposal', confidence: 0.55, reasons: [proposal[1]] };
  return null;
};

/** Raises a rule finding's confidence for where it was written, with the reasons the UI shows. */
function placed(verdict: SentenceClassification, context: SentenceContext): SentenceClassification {
  if (verdict.kind !== 'decision') return verdict;
  let confidence = verdict.confidence;
  const reasons = [...verdict.reasons];
  if (DECISION_TITLE.test(context.sourceTitle)) {
    confidence += 0.05;
    reasons.push('Source title suggests a decision record');
  }
  if (context.underDecisionHeading) {
    confidence += 0.05;
    reasons.push('Listed under a decisions heading');
  }
  return { kind: verdict.kind, confidence: Math.round(Math.min(0.95, confidence) * 100) / 100, reasons };
}

// ---------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------

const isText = (v: unknown): v is string => typeof v === 'string';
const validTime = (v: unknown) => isText(v) && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));

interface CheckedInput {
  sources: SourceRecord[];
  issues: IssueRecord[];
  maxCandidates: number;
  warnings: ExtractionWarning[];
}

function checkInput(input: unknown): CheckedInput {
  const warnings: ExtractionWarning[] = [];
  const out: CheckedInput = { sources: [], issues: [], maxCandidates: DEFAULT_MAX_CANDIDATES, warnings };
  if (!input || typeof input !== 'object') {
    warnings.push({ code: 'invalid_input', message: 'Extraction input must be an object with sources and issues.' });
    return out;
  }
  const { sources, issues, maxCandidates } = input as Partial<ExtractionInput>;
  if (!Array.isArray(sources) || (issues !== undefined && !Array.isArray(issues))) {
    warnings.push({ code: 'invalid_input', message: 'Extraction input needs a sources list and an issues list.' });
    if (!Array.isArray(sources)) return out;
  }

  if (maxCandidates !== undefined) {
    if (Number.isInteger(maxCandidates) && (maxCandidates as number) > 0) out.maxCandidates = maxCandidates as number;
    else warnings.push({ code: 'invalid_option', message: `maxCandidates must be a positive whole number; using ${DEFAULT_MAX_CANDIDATES}.` });
  }

  const seenSources = new Set<string>();
  for (const s of sources as unknown[]) {
    const r = s as Partial<SourceRecord> | null;
    const id = r && isText(r.id) && r.id ? r.id : undefined;
    if (!r || typeof r !== 'object' || !id || !SOURCE_TYPES.includes(r.type as SourceType) || !isText(r.title) || !isText(r.text) || !isText(r.projectKey)) {
      warnings.push({ code: 'invalid_source', message: 'A source was skipped: it needs an id, a known type, a title, text and a project key.', ...(id ? { recordId: id } : {}) });
      continue;
    }
    if (!validTime(r.updatedAt)) {
      // Kept: the time is shown, never used to find or match anything.
      warnings.push({ code: 'invalid_timestamp', message: `Source ${id} has no valid ISO updatedAt; it is still scanned.`, recordId: id });
    }
    if (seenSources.has(id)) {
      warnings.push({ code: 'duplicate_source', message: `Source ${id} appears more than once; the first copy is used.`, recordId: id });
      continue;
    }
    seenSources.add(id);
    out.sources.push({ ...(r as SourceRecord), url: isText(r.url) ? r.url : '', updatedAt: isText(r.updatedAt) ? r.updatedAt : '' });
  }

  const seenIssues = new Set<string>();
  for (const i of (Array.isArray(issues) ? issues : []) as unknown[]) {
    const r = i as Partial<IssueRecord> | null;
    const id = r && isText(r.key) && r.key ? r.key : r && isText(r.id) ? r.id : undefined;
    if (!r || typeof r !== 'object' || !isText(r.id) || !isText(r.key) || !/^[A-Z][A-Z0-9_]*-\d+$/.test(r.key) || !isText(r.title) || !isText(r.projectKey)) {
      warnings.push({ code: 'invalid_issue', message: 'An issue was skipped: it needs an id, a key such as ABC-12, a title and a project key.', ...(id ? { recordId: id } : {}) });
      continue;
    }
    if (!validTime(r.updatedAt)) {
      warnings.push({ code: 'invalid_timestamp', message: `Issue ${r.key} has no valid ISO updatedAt; it is still matched.`, recordId: r.key });
    }
    if (seenIssues.has(r.key)) {
      warnings.push({ code: 'duplicate_issue', message: `Issue ${r.key} appears more than once; the first copy is used.`, recordId: r.key });
      continue;
    }
    seenIssues.add(r.key);
    out.issues.push({ ...(r as IssueRecord), ...(r.description !== undefined && !isText(r.description) ? { description: undefined } : {}) });
  }

  if (out.sources.length === 0) warnings.push({ code: 'empty_input', message: 'There was no readable source text to scan.' });
  return out;
}

// ---------------------------------------------------------------------------
// Building findings
// ---------------------------------------------------------------------------

const withoutText = ({ text: _text, ...rest }: SourceRecord): CandidateSource => {
  const source: CandidateSource = { id: rest.id, type: rest.type, title: rest.title, url: rest.url, projectKey: rest.projectKey, updatedAt: rest.updatedAt };
  if (rest.author !== undefined) source.author = rest.author;
  if (rest.via !== undefined) source.via = rest.via;
  return source;
};

/** The quote without a leading label, first letter capitalised, at most 280 characters on a word boundary. */
export function summarize(quote: string): string {
  let text = quote.trim()
    .replace(DECISION_LABEL, '')
    .replace(QUESTION_LABEL, '')
    .replace(PROPOSAL_LABEL, '')
    .trim();
  if (!text) text = quote.trim();
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (text.length <= MAX_QUOTE_LENGTH) return text;
  const cut = text.slice(0, MAX_QUOTE_LENGTH - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_QUOTE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

function contextFor(sentence: Sentence, all: Sentence[], index: number, source: SourceRecord): SentenceContext {
  const underDecisionHeading = Boolean(sentence.heading) && DECISION_HEADING.test(sentence.heading) && !QUESTION_HEADING.test(sentence.heading);
  let answeredByReply = false;
  if (sentence.text.trim().endsWith('?')) {
    const asker = speakerOf(withoutListMark(sentence.lineText));
    const next = all.slice(index + 1).find((s) => s.line > sentence.line);
    // The next speaker answers, unless they reply with a question of their own.
    const replier = next && next.line === sentence.line + 1 && !next.lineText.includes('?') ? speakerOf(withoutListMark(next.lineText)) : null;
    answeredByReply = Boolean(asker && replier && asker !== replier);
  }
  return {
    sourceType: source.type,
    sourceTitle: source.title,
    underDecisionHeading,
    decisionListItem: underDecisionHeading && sentence.listItem,
    answeredByReply,
    followsOutcomeMarker: index > 0 && OUTCOME_MARKER.test(plain(all[index - 1].text).trim())
  };
}

/** A transcript line can also be a list item: "- josh: What is the motivation?". */
const withoutListMark = (line: string) => line.replace(/^(?:[-*\u2022]|\d{1,3}[.)])\s+/, '');

function candidateFor(source: SourceRecord, sentence: Pick<Sentence, 'text' | 'start' | 'end' | 'lineText'>, verdict: SentenceClassification, index: IssueIndex): DecisionCandidate {
  const summary = summarize(sentence.text);
  return {
    id: stableId(source.id, summary),
    kind: verdict.kind,
    summary,
    evidence: { quote: sentence.text, start: sentence.start, end: sentence.end },
    source: withoutText(source),
    confidence: verdict.confidence,
    confidenceReasons: verdict.reasons,
    affectedIssues: matchIssues({
      quote: sentence.text, summary, paragraph: sentence.lineText, sourceTitle: source.title, sourceType: source.type
    }, index)
  };
}

const validVerdict = (v: SentenceClassification | null): v is SentenceClassification =>
  Boolean(v) && KINDS.includes(v!.kind) && Number.isFinite(v!.confidence) && Array.isArray(v!.reasons);

/** Decisions, proposals and open questions in `input.sources`, in source order, with the issues each may affect. */
export function extractDecisions(input: ExtractionInput, options: ExtractionOptions = {}): ExtractionResult {
  const checked = checkInput(input);
  const warnings = checked.warnings;
  const classify = typeof options?.classifier === 'function' ? options.classifier : defaultClassifier;
  const index = indexIssues(checked.issues);
  const candidates: DecisionCandidate[] = [];
  const seen = new Set<string>();
  let found = 0;

  for (const source of checked.sources) {
    const sentences = sentencesOf(source.text);
    sentences.forEach((sentence, i) => {
      if (sentence.text.length > MAX_QUOTE_LENGTH) return;
      const context = contextFor(sentence, sentences, i, source);
      const verdict = classify(sentence.text, context);
      if (!validVerdict(verdict)) return;
      const candidate = candidateFor(source, sentence, placed({ ...verdict, confidence: Math.max(0, Math.min(1, verdict.confidence)) }, context), index);
      if (seen.has(candidate.id)) return; // the same wording twice in one source is one finding
      seen.add(candidate.id);
      found++;
      if (candidates.length < checked.maxCandidates) candidates.push(candidate);
    });
  }

  if (found > candidates.length) {
    warnings.push({
      code: 'candidates_truncated',
      message: `Showing the first ${candidates.length} of ${found} findings. Narrow the scan to see the rest.`
    });
  }
  return { candidates, warnings };
}

// ---------------------------------------------------------------------------
// Checking what a model proposes
// ---------------------------------------------------------------------------

/** A finding a model proposed: the source it is in, the exact sentence and its kind. */
export interface ProposedFinding {
  sourceId: string;
  quote: string;
  kind: DecisionKind;
  reason?: string;
}

export interface VerifiedFindings {
  candidates: DecisionCandidate[];
  /** How many proposals failed a check. */
  rejected: number;
}

const AI_REASON = 'Found by the AI pass; the quote was checked word for word against the source';

/**
 * Keeps a model's proposal only if its quote is one or more whole sentences found word for word
 * in that source (typographic quotes may differ), at most 280 characters, of a valid kind, not a
 * reference line, not a negated or reversed decision, and not overlapping a `known` finding.
 * Accepted findings get the same shape and issue matching as rule findings.
 */
export function verifyProposedFindings(input: ExtractionInput, proposals: ProposedFinding[], known: DecisionCandidate[] = []): VerifiedFindings {
  const checked = checkInput(input);
  const index = indexIssues(checked.issues);
  const sources = new Map(checked.sources.map((s) => [s.id, s]));
  const taken = new Map<string, Array<[number, number]>>();
  for (const c of Array.isArray(known) ? known : []) {
    if (!c?.source?.id || !c.evidence) continue;
    if (!taken.has(c.source.id)) taken.set(c.source.id, []);
    taken.get(c.source.id)!.push([c.evidence.start, c.evidence.end]);
  }

  const candidates: DecisionCandidate[] = [];
  const ids = new Set((Array.isArray(known) ? known : []).map((c) => c?.id));
  let rejected = 0;
  for (const proposal of Array.isArray(proposals) ? proposals : []) {
    const candidate = verifyOne(proposal, sources, taken, index);
    if (!candidate || ids.has(candidate.id)) {
      rejected++;
      continue;
    }
    ids.add(candidate.id);
    if (!taken.has(candidate.source.id)) taken.set(candidate.source.id, []);
    taken.get(candidate.source.id)!.push([candidate.evidence.start, candidate.evidence.end]);
    candidates.push(candidate);
  }
  return { candidates, rejected };
}

function verifyOne(
  proposal: ProposedFinding,
  sources: Map<string, SourceRecord>,
  taken: Map<string, Array<[number, number]>>,
  index: IssueIndex
): DecisionCandidate | null {
  if (!proposal || typeof proposal !== 'object' || !KINDS.includes(proposal.kind)) return null;
  const quote = isText(proposal.quote) ? proposal.quote.trim() : '';
  const source = isText(proposal.sourceId) ? sources.get(proposal.sourceId) : undefined;
  if (!source || quote.length < 2 || quote.length > MAX_QUOTE_LENGTH) return null;

  // Whole sentences only: the quote must start where one sentence starts and end where one ends, on one line.
  const wanted = comparable(quote);
  const sentences = sentencesOf(source.text);
  let span: { text: string; start: number; end: number; lineText: string } | null = null;
  for (let a = 0; a < sentences.length && !span; a++) {
    for (let b = a; b < sentences.length && sentences[b].line === sentences[a].line; b++) {
      const text = source.text.slice(sentences[a].start, sentences[b].end);
      if (text.length > MAX_QUOTE_LENGTH) break;
      if (comparable(text) === wanted) {
        span = { text, start: sentences[a].start, end: sentences[b].end, lineText: sentences[a].lineText };
        break;
      }
    }
  }
  if (!span) return null;
  if ((taken.get(source.id) ?? []).some(([a, b]) => span!.start < b && span!.end > a)) return null;

  const t = spoken(plain(span.text)).text.toLowerCase();
  if (REFERENCE_LABEL.test(plain(span.text).trim()) || /^#/.test(span.text)) return null;
  if (proposal.kind === 'decision' && !DECISION_LABEL.test(plain(span.text)) && (REVERSED.test(t) || NEGATED.test(t) || UNDECIDED.test(t))) return null;

  return candidateFor(source, span, { kind: proposal.kind, confidence: 0.6, reasons: [AI_REASON] }, index);
}
