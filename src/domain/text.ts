/**
 * Reading plain source text: lines, headings, list items and sentences with exact offsets.
 * Offsets always point into the original text, so a quote can be shown and verified as written.
 */

/** Curly quotes and apostrophes read as their ASCII forms, for matching only (never for quoting). */
export function plain(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
}

/** Lower case, ASCII quotes, single spaces: the form used to compare wording. */
export function comparable(text: string): string {
  return plain(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A heading line, or one sentence with its position in the source text. */
export type SourceLine = { heading: string } | { sentence: string; start: number; end: number; listItem: boolean };

/** A sentence with the line it came from, used internally for context. */
export interface Sentence {
  text: string;
  start: number;
  end: number;
  listItem: boolean;
  /** Index of the source line, so neighbouring lines can be looked up. */
  line: number;
  /** The whole line the sentence sits on (its paragraph). */
  lineText: string;
  /** The nearest heading above, or '' when there is none. */
  heading: string;
}

const HEADING = /^#{1,6}\s+/;
const LIST_MARK = /^(?:[-*\u2022]|\d{1,3}[.)])\s+/;

/**
 * Splits one line into sentence ranges [start, end) relative to the line. A sentence ends at
 * ".", "!" or "?" followed by a space or the end of the line, so "3.5" and "file.ts" stay whole.
 * Abbreviations such as "e.g." do end a piece: the AI pass numbers exactly these pieces, so a
 * numbered sentence always verifies word for word.
 */
function sentenceRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    // Keep closing quotes and brackets with the sentence they end.
    let end = i + 1;
    while (end < line.length && /["'\u2019\u201D)\]]/.test(line[end])) end++;
    if (end < line.length && !/\s/.test(line[end])) continue;
    ranges.push([start, end]);
    start = end;
    i = end - 1;
  }
  if (start < line.length) ranges.push([start, line.length]);
  return ranges
    .map(([a, b]): [number, number] => {
      while (a < b && /\s/.test(line[a])) a++;
      while (b > a && /\s/.test(line[b - 1])) b--;
      return [a, b];
    })
    .filter(([a, b]) => b > a);
}

/** Every sentence in the text, with its line, paragraph and heading. */
export function sentencesOf(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  let offset = 0;
  let heading = '';
  text.split('\n').forEach((rawLine, lineIndex) => {
    const lineStart = offset;
    offset += rawLine.length + 1;
    const lead = rawLine.length - rawLine.trimStart().length;
    let body = rawLine.slice(lead);
    let bodyStart = lineStart + lead;
    if (!body.trim()) return;
    if (HEADING.test(body)) {
      heading = body.replace(HEADING, '').trim();
      return;
    }
    const mark = body.match(LIST_MARK);
    const listItem = Boolean(mark);
    if (mark) {
      body = body.slice(mark[0].length);
      bodyStart += mark[0].length;
    }
    for (const [a, b] of sentenceRanges(body)) {
      sentences.push({
        text: body.slice(a, b), start: bodyStart + a, end: bodyStart + b, listItem,
        line: lineIndex, lineText: rawLine.trim(), heading
      });
    }
  });
  return sentences;
}

/** The text as an ordered list of headings and sentences, as the AI pass numbers them. */
export function sourceLines(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  const byLine = new Map<number, Sentence[]>();
  for (const s of sentencesOf(text)) {
    if (!byLine.has(s.line)) byLine.set(s.line, []);
    byLine.get(s.line)!.push(s);
  }
  text.split('\n').forEach((rawLine, lineIndex) => {
    const trimmed = rawLine.trim();
    if (HEADING.test(trimmed)) {
      out.push({ heading: trimmed.replace(HEADING, '').trim() });
      return;
    }
    for (const s of byLine.get(lineIndex) ?? []) out.push({ sentence: s.text, start: s.start, end: s.end, listItem: s.listItem });
  });
  return out;
}

/** "name: text" at the start of a transcript line, or null. */
export function speakerOf(line: string): string | null {
  const m = line.match(/^([A-Za-z][\w.@-]{0,30}(?:\s[A-Za-z][\w.-]{0,20})?):\s+\S/);
  return m ? m[1].toLowerCase() : null;
}
