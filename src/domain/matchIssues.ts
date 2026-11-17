/**
 * Which Jira issues a finding may affect, and the wording a decision replaces.
 * Pure: the same finding and issues always give the same matches.
 */
import type { AffectedIssue, IssueRecord } from './decisionTypes';
import { comparable, plain } from './text';

// ---------------------------------------------------------------------------
// The wording a decision replaces
// ---------------------------------------------------------------------------

/** What a decision changes: the old wording (`from`, or `removed` when nothing replaces it) and the new (`to`). */
export interface WordingChange {
  from?: string;
  to?: string;
  removed?: string;
}

const MAX_PHRASE_WORDS = 6;
const LEADING = /^(?:the|a|an|our|their|its|his|her|my|your|this|that|these|those|any|all|every|each|some|both)\s+/i;
// A phrase ends where a new clause or a trailing qualifier begins ("legacy card form | for checkout").
const PHRASE_STOP = new Set([
  'for', 'in', 'at', 'on', 'by', 'with', 'from', 'to', 'into', 'onto', 'before', 'after', 'during', 'until',
  'when', 'while', 'because', 'since', 'so', 'and', 'but', 'or', 'as', 'unless', 'if', 'which', 'that', 'where'
]);

const stripLeading = (words: string[]) => {
  while (words.length > 1 && LEADING.test(`${words[0]} `)) words.shift();
  return words;
};
const finish = (words: string[]) => {
  const text = words.join(' ').replace(/^[("'“]+/, '').replace(/[.!?;:,)"'”]+$/, '').trim();
  return /[a-z]{3,}/i.test(text) ? text : undefined;
};

/** Cleans the old wording: no leading article or possessive, stops at a new clause, at most 6 words. */
function tidyPhrase(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let words = stripLeading(raw.trim().split(/\s+/).filter(Boolean));
  // A stop word ends the phrase only when more words follow it ("evening before" stays whole).
  const stop = words.findIndex((w, i) => i > 0 && i < words.length - 1 && PHRASE_STOP.has(w.toLowerCase()));
  if (stop > 0) words = words.slice(0, stop);
  return finish(words.slice(0, MAX_PHRASE_WORDS));
}

// Where the new wording begins, reading back from "instead of": a preposition starts it
// ("go live | after the website update"); a verb or "to" comes just before it ("use | one shared plan").
const STARTS_PHRASE = new Set(['on', 'at', 'in', 'after', 'before', 'by', 'from', 'every', 'each', 'via', 'through', 'with', 'within', 'during', 'once']);
const ENDS_LEAD_IN = new Set([
  'to', 'use', 'uses', 'using', 'adopt', 'adopts', 'choose', 'chooses', 'pick', 'picks', 'prefer', 'prefers',
  'keep', 'keeps', 'send', 'sends', 'cover', 'covers', 'move', 'moves', 'switch', 'go', 'goes', 'is', 'are', 'be',
  'was', 'were', 'cap', 'caps', 'ship', 'ships', 'publish', 'require', 'requires', 'handle', 'handles',
  'we', 'will', 'should', 'agreed', 'decided', 'approved'
]);

/** The new wording: the end of the clause before "instead of" / "rather than". */
function newWording(clause: string): string | undefined {
  const words = clause.trim().replace(/\s+only$/i, '').split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = words.length - 1; i >= 0 && kept.length < MAX_PHRASE_WORDS; i--) {
    const w = words[i].toLowerCase().replace(/[^a-z'-]/g, '');
    if (ENDS_LEAD_IN.has(w)) break;
    kept.unshift(words[i]);
    if (STARTS_PHRASE.has(w)) break;
  }
  return finish(stripLeading(kept));
}

/** The text after a pattern, up to the end of its clause. */
const clauseAfter = (text: string, at: number) => text.slice(at).split(/[.;:!?,]|\s[-–—]\s/)[0];
/** The text before a position, back to the start of its clause. */
const clauseBefore = (text: string, at: number) => {
  const parts = text.slice(0, at).split(/[.;:!?,]|\s[-–—]\s/).map((p) => p.trim());
  // "X only, instead of Y": skip a clause that is empty or only "only".
  while (parts.length > 1 && /^(?:only)?$/i.test(parts[parts.length - 1])) parts.pop();
  return parts[parts.length - 1];
};

/**
 * The wording a decision replaces, or undefined. Recognises "X instead of Y", "X rather than Y",
 * "replace Y with X", "move/switch/change/migrate from Y to X", "Y is out of scope", "no longer Y"
 * and "stop Y".
 */
export function extractChange(text: string): WordingChange | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const t = plain(text);

  const instead = t.match(/\b(?:instead of|rather than)\s+/i);
  if (instead && instead.index !== undefined) {
    const from = tidyPhrase(clauseAfter(t, instead.index + instead[0].length));
    if (from) {
      const to = newWording(clauseBefore(t, instead.index));
      return to ? { from, to } : { from };
    }
  }

  const replace = t.match(/\breplac(?:e|es|ed|ing)\s+(.+?)\s+with\s+(.+)/i);
  if (replace) {
    const from = tidyPhrase(replace[1]);
    if (from) {
      const to = tidyPhrase(clauseAfter(replace[2], 0));
      return to ? { from, to } : { from };
    }
  }

  const move = t.match(/\b(?:move|moves|moved|moving|switch|switches|switched|switching|change|changes|changed|changing|migrate|migrates|migrated|migrating)\b(?:[^.;]*?)\bfrom\s+(.+?)\s+to\s+(.+)/i);
  if (move) {
    const from = tidyPhrase(move[1]);
    if (from) {
      const to = tidyPhrase(clauseAfter(move[2], 0));
      return to ? { from, to } : { from };
    }
  }

  // "Product documentation is out of scope": the subject is dropped from the plan.
  const scope = t.match(/^(?:[a-z]+\b[^:]{0,24}:\s*)?(.+?)\s+(?:is|are)\s+(?:now\s+)?(?:out of scope|descoped|dropped|cancelled|canceled)\b/i);
  if (scope) {
    const removed = tidyPhrase(scope[1].split(/[,;]\s*/).pop());
    if (removed) return { removed };
  }

  const noLonger = t.match(/\bno longer\s+/i) ?? t.match(/\b(?:stop|stops|stopped|stopping)\s+(?=\w)/i);
  if (noLonger && noLonger.index !== undefined) {
    const removed = tidyPhrase(clauseAfter(t, noLonger.index + noLonger[0].length));
    if (removed) return { removed };
  }
  return undefined;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the issue's title or description contains `phrase`, ignoring case and spacing, at word boundaries. */
export function issueStillMentions(issue: Pick<IssueRecord, 'title' | 'description'> | null | undefined, phrase: string | undefined): boolean {
  if (!issue || typeof phrase !== 'string') return false;
  const wanted = comparable(phrase);
  if (!wanted) return false;
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${wanted.split(' ').map(escapeRegExp).join('\\s+')}(?=$|[^\\p{L}\\p{N}])`, 'u');
  return [issue.title, issue.description].some((field) => typeof field === 'string' && pattern.test(comparable(field)));
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(`
a about above after again all also am an and any are as at be because been before being below between both
but by can could did do does doing done down during each either else ever every few for from further get gets
got had has have having he her here hers him his how i if in into is it its itself just let lets like made make
may me might more most much must my no nor not now of off on once one only or other our ours out over own per
probably please same shall she should so some such than that the their them then there these they this those
through to too under until up upon us use used using very via was we were what when where whether which while
who whom why will with within without would yes yet you your
agreed agree decided decide decision decisions team teams going will week weeks today new old instead rather
`.split(/\s+/).filter(Boolean));

/** A light stemmer: enough to match "plans" with "plan" and "sending" with "send". */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  for (const suffix of ['ingly', 'ings', 'ing', 'edly', 'ed', 'es', 's']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      if (suffix === 's' && /(?:ss|us|is)$/.test(w)) break;
      w = w.slice(0, -suffix.length);
      if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(?:ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
      break;
    }
  }
  return w;
}

/** Meaningful words of a text in order, as [stem, word] pairs. */
function wordsOf(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of plain(text).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    const word = raw.replace(/'s$/, '').replace(/['-]+$/, '');
    if (word.length < 3 || STOP_WORDS.has(word) || /^\d+$/.test(word)) continue;
    out.push([stem(word), word]);
  }
  return out;
}

/** Meaningful terms of a text: stem -> the first form it appeared in. */
export function termsOf(text: string): Map<string, string> {
  const terms = new Map<string, string>();
  for (const [s, word] of wordsOf(text)) if (!terms.has(s)) terms.set(s, word);
  return terms;
}

/** Neighbouring meaningful words ("guest checkout"), as "stem stem". */
function pairsOf(text: string): Set<string> {
  const words = wordsOf(text);
  const pairs = new Set<string>();
  for (let i = 1; i < words.length; i++) pairs.add(`${words[i - 1][0]} ${words[i][0]}`);
  return pairs;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** What is known about a finding when its issues are matched. */
export interface MatchContext {
  quote: string;
  summary: string;
  /** The whole line (paragraph) the quote sits on. */
  paragraph: string;
  /** The source title, which names the issue for Jira descriptions and comments. */
  sourceTitle: string;
  sourceType: string;
}

/** Issues prepared once per extraction: their terms and how common each term is. */
export interface IssueIndex {
  issues: IssueRecord[];
  terms: Map<string, Map<string, string>>;
  pairs: Map<string, Set<string>>;
  documentFrequency: Map<string, number>;
}

export function indexIssues(issues: IssueRecord[]): IssueIndex {
  const terms = new Map<string, Map<string, string>>();
  const pairs = new Map<string, Set<string>>();
  const documentFrequency = new Map<string, number>();
  for (const issue of issues) {
    const own = termsOf(`${issue.title} ${issue.description ?? ''}`);
    terms.set(issue.key, own);
    pairs.set(issue.key, new Set([...pairsOf(issue.title), ...pairsOf(issue.description ?? '')]));
    for (const s of own.keys()) documentFrequency.set(s, (documentFrequency.get(s) ?? 0) + 1);
  }
  return { issues, terms, pairs, documentFrequency };
}

const MIN_RELEVANCE = 0.3;
/** Shared terms alone are a weaker signal, so they need more to count. */
const MIN_TERMS_ONLY = 0.4;
const MAX_ISSUES = 5;
const MAX_LISTED_TERMS = 4;

const mentionsKey = (text: string, key: string) => new RegExp(`(?:^|[^A-Z0-9-])${escapeRegExp(key)}(?![0-9])`, 'i').test(text);
const quoted = (s: string) => `“${s}”`;

/** Combines independent signals: each closes part of the remaining gap to 1. */
const combine = (strengths: number[]) => Math.min(0.99, 1 - strengths.reduce((rest, s) => rest * (1 - s), 1));

/** The issues a finding may affect, strongest first, with the plain reasons for each. */
export function matchIssues(context: MatchContext, index: IssueIndex): AffectedIssue[] {
  const change = extractChange(context.summary);
  const oldWording = change?.from ?? change?.removed;
  const quoteTerms = termsOf(context.quote);
  const quotePairs = pairsOf(context.quote);
  const total = Math.max(index.issues.length, 1);
  const matches: AffectedIssue[] = [];

  for (const issue of index.issues) {
    const strengths: number[] = [];
    const reasons: string[] = [];
    let wordingStatus: AffectedIssue['wordingStatus'];
    let outdatedWording: string | undefined;

    if (mentionsKey(context.quote, issue.key)) {
      strengths.push(0.9);
      reasons.push(`The decision names ${issue.key}`);
    } else if (mentionsKey(context.paragraph, issue.key)) {
      strengths.push(0.8);
      reasons.push(`The same paragraph as the decision lists ${issue.key}`);
    } else if (context.sourceType !== 'confluence_page' && mentionsKey(context.sourceTitle, issue.key)) {
      strengths.push(0.7);
      reasons.push(`The decision was recorded on ${issue.key}`);
    }

    if (oldWording && issueStillMentions(issue, oldWording)) {
      strengths.push(0.85);
      reasons.push(`The issue still mentions ${quoted(oldWording)}, which this decision replaces`);
      wordingStatus = 'outdated';
      outdatedWording = oldWording;
    } else if (change?.from && change.to && issueStillMentions(issue, change.to)) {
      strengths.push(0.35);
      reasons.push(`The issue already uses the new wording ${quoted(change.to)}`);
      wordingStatus = 'replacement-found';
    }

    const issueTerms = index.terms.get(issue.key) ?? new Map();
    const shared: Array<{ word: string; weight: number }> = [];
    for (const [s, word] of quoteTerms) {
      if (!issueTerms.has(s)) continue;
      const df = index.documentFrequency.get(s) ?? 1;
      // A term most issues share says little; one only this issue has says more.
      const rarity = total <= 1 ? 1 : 1 - (df - 1) / (total - 1);
      shared.push({ word, weight: 0.08 + 0.17 * rarity });
    }
    if (shared.length >= 2) {
      // Two words side by side in both ("guest checkout") say more than the same words apart.
      const issuePairs = index.pairs.get(issue.key) ?? new Set();
      const phrase = [...quotePairs].some((pair) => issuePairs.has(pair)) ? [0.15] : [];
      strengths.push(Math.min(0.6, combine([...shared.map((t) => t.weight), ...phrase])));
      const listed = [...shared].sort((a, b) => b.weight - a.weight).slice(0, MAX_LISTED_TERMS).map((t) => quoted(t.word));
      reasons.push(`Shares terms with the issue: ${listed.join(', ')}`);
    }

    if (strengths.length === 0) continue;
    const relevance = Math.round(combine(strengths) * 100) / 100;
    if (relevance < (reasons.length === 1 && shared.length >= 2 ? MIN_TERMS_ONLY : MIN_RELEVANCE)) continue;
    matches.push({
      issueKey: issue.key,
      relevance,
      ...(wordingStatus ? { wordingStatus } : {}),
      ...(outdatedWording ? { outdatedWording } : {}),
      reasons
    });
  }

  return matches
    .sort((a, b) => b.relevance - a.relevance || a.issueKey.localeCompare(b.issueKey, 'en', { numeric: true }))
    .slice(0, MAX_ISSUES);
}
