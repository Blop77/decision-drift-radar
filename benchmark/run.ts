/**
 * Accuracy benchmark for the rule-based extractor (src/domain) on real, openly licensed meeting
 * notes. Run: npm run benchmark. Prints a summary and writes benchmark/RESULTS.md.
 *
 * Four sets: development notes used for tuning, held-out notes, a fresh set and a decisions-only
 * recall set. Each is scored with the current rules. The rules were rewritten on 17 Nov 2026; the
 * scores published for the earlier rules are shown beside them as fixed numbers (EARLIER).
 * Complete recorded AI results add a combined score using the same labels and matching rules.
 *
 * Matching: a finding matches a label when one normalised text contains the other, and the
 * shorter is at least half as long as the longer. Each label and each finding is used at most
 * once. Findings that match an ambiguous label are ignored; strict labels decide the score.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalize, prepareMarkdown } from './prepare.ts';

type Kind = 'decision' | 'open_question' | 'proposal';
interface Label { kind: Kind; text: string; ambiguous?: boolean }
interface Tally { tp: number; fp: number; fn: number }
type Extract = (input: unknown) => { candidates: Array<{ kind: string; evidence: { quote: string } }> };
type AiEntry = { set: string; file: string; inputSha256: string; status: string; ai?: Array<{ kind: Kind; quote: string }>; rejected?: number };
type AiRun = { model: string | null; protocol: string; ranAt: string; labels: Record<string, string>; files: AiEntry[] };
const resultPath = 'benchmark/ai-results.json';
const aiRun: AiRun | null = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const KINDS: Kind[] = ['decision', 'open_question', 'proposal'];

/**
 * The scores published for the earlier rules (RESULTS.md as published on 17 Nov 2026), before
 * the rewrite: precision / recall per kind, and TP / FP / FN counts. Fixed text, not re-run.
 */
const EARLIER: Record<string, { pairs: Partial<Record<Kind | 'any', string>>; counts: Partial<Record<'decision' | 'any', [number, number, number]>>; ambiguous: number }> = {
  recall: { pairs: { decision: '100% / 70%' }, counts: { decision: [7, 0, 3] }, ambiguous: 0 },
  fresh: { pairs: { decision: '100% / 20%', open_question: '13% / 33%', proposal: '25% / 100%', any: '23% / 33%' }, counts: { decision: [1, 0, 4], any: [3, 10, 6] }, ambiguous: 20 },
  heldout: { pairs: { decision: '100% / 25%', open_question: '100% / 86%', proposal: '63% / 80%', any: '88% / 78%' }, counts: { decision: [2, 0, 6], any: [29, 4, 8] }, ambiguous: 14 },
  corpus: { pairs: { decision: '100% / 70%', open_question: '100% / 83%', proposal: '86% / 86%', any: '100% / 83%' }, counts: { decision: [7, 0, 3], any: [24, 0, 5] }, ambiguous: 14 }
};
const earlier = (dir: string, k: Kind | 'any') => EARLIER[dir]?.pairs[k] ?? 'n/a';
const KIND_NAME: Record<Kind, string> = { decision: 'Decisions', open_question: 'Open questions', proposal: 'Proposals' };
/** `kinds` limits which findings are scored (the recall set labels decisions only). */
const SETS: Array<{ name: string; dir: string; labels: string; sources: string; kinds?: Kind[] }> = [
  { name: 'Recall set (decisions only, labels frozen before any run)', dir: 'recall', labels: 'labels-recall.json', sources: 'sources-recall.tsv', kinds: ['decision'] },
  { name: 'Fresh set (labels frozen before any run; used once for the commitment-vs-opinion change)', dir: 'fresh', labels: 'labels-fresh.json', sources: 'sources-fresh.tsv' },
  { name: 'Held-out set', dir: 'heldout', labels: 'labels-heldout.json', sources: 'sources-heldout.tsv' },
  { name: 'Development set (used for tuning)', dir: 'corpus', labels: 'labels.json', sources: 'sources.tsv' },
  { name: 'Second development set (used for tuning; labels frozen before any run)', dir: 'dev2', labels: 'labels-dev2.json', sources: 'sources-dev2.tsv' }
];

function matches(finding: string, label: string): boolean {
  const a = normalize(finding);
  const b = normalize(label);
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.includes(short) && short.length >= long.length / 2;
}

function score(set: (typeof SETS)[number], extract: Extract, ai = new Map<string, AiEntry>()) {
  const docs = (JSON.parse(readFileSync(`benchmark/${set.labels}`, 'utf8')) as { documents: Array<{ file: string; labels: Label[] }> }).documents;
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { tp: 0, fp: 0, fn: 0 }])) as Record<Kind, Tally>;
  const any: Tally = { tp: 0, fp: 0, fn: 0 };
  const misses: string[] = [];
  const wrongKind: string[] = [];
  const falseAlarms: string[] = [];
  let ignored = 0;
  let findingsTotal = 0;

  for (const doc of docs) {
    const text = prepareMarkdown(readFileSync(`benchmark/${set.dir}/${doc.file}`, 'utf8'));
    const { candidates } = extract({
      sources: [{ id: `bench-${doc.file}`, type: 'confluence_page', title: doc.file, url: '', projectKey: 'BENCH', updatedAt: '2026-01-01T00:00:00Z', text }],
      issues: []
    });
    const entry = ai.get(doc.file);
    const combined = entry
      ? [...candidates, ...entry.ai!.map(({ kind, quote }) => ({ kind, evidence: { quote } }))]
      : candidates;
    const scored = set.kinds ? combined.filter((c) => set.kinds!.includes(c.kind as Kind)) : combined;
    findingsTotal += scored.length;
    const used = new Set<number>();
    for (const c of scored) {
      const kind = c.kind as Kind;
      const hit = doc.labels
        .map((label, index) => ({ label, index }))
        .filter(({ index, label }) => !used.has(index) && matches(c.evidence.quote, label.text))
        .sort((x, y) => Number(y.label.kind === kind) - Number(x.label.kind === kind))[0];
      if (!hit) {
        byKind[kind].fp++;
        any.fp++;
        falseAlarms.push(`${doc.file} · ${kind} · “${c.evidence.quote}”`);
        continue;
      }
      used.add(hit.index);
      if (hit.label.ambiguous) {
        ignored++;
        continue;
      }
      any.tp++;
      if (hit.label.kind === kind) byKind[kind].tp++;
      else {
        byKind[kind].fp++;
        byKind[hit.label.kind].fn++;
        wrongKind.push(`${doc.file} · labelled ${hit.label.kind}, found as ${kind} · “${hit.label.text}”`);
      }
    }
    doc.labels.forEach((label, index) => {
      if (label.ambiguous || used.has(index)) return;
      byKind[label.kind].fn++;
      any.fn++;
      misses.push(`${doc.file} · ${label.kind} · “${label.text}”`);
    });
  }
  const all = docs.flatMap((d) => d.labels);
  return {
    byKind, any, misses, wrongKind, falseAlarms, ignored, findingsTotal,
    strict: all.filter((l) => !l.ambiguous).length, ambiguous: all.filter((l) => l.ambiguous).length, files: docs.length
  };
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}%`);
const pair = (t: Tally) => `${pct(t.tp, t.tp + t.fp)} / ${pct(t.tp, t.tp + t.fn)}`;
const decisionCounts = ({ tp, fp, fn }: Tally) =>
  `${tp} found, ${fp} false ${fp === 1 ? "positive" : "positives"}, ${fn} ${fn === 1 ? "miss" : "misses"}`;

const current = (await import('../src/domain/extractDecisions.ts')).extractDecisions as Extract;

const lines = [
  '# Accuracy benchmark results',
  '',
  'Generated by `npm run benchmark`. Each cell is precision / recall. "Current rules" is `src/domain` as it is now; the extraction rules were rewritten from a written spec on 17 Nov 2026. "Before the rewrite" repeats the scores published for the earlier rules, as fixed numbers. Every set had been seen before the rewrite, so none of these scores is a blind test of the new rules. Rules + AI appears only for sets with a complete recorded run; its AI answers were recorded with the earlier rules, so they are re-scored here, not re-run. See [README.md](README.md) for the method.',
  ''
];
const summary: string[] = [];
for (const set of SETS) {
  const after = score(set, current);
  const entries = aiRun?.files.filter((entry) => entry.set === set.dir) ?? [];
  const ai = new Map(entries.map((entry) => [entry.file, entry]));
  const labelText = readFileSync(`benchmark/${set.labels}`, 'utf8');
  const docs = JSON.parse(labelText).documents as Array<{ file: string }>;
  const complete = Boolean(aiRun?.model && aiRun.labels[set.labels] === sha256(labelText)
    && entries.length === docs.length && docs.every(({ file }) => {
      const entry = ai.get(file);
      const text = prepareMarkdown(readFileSync(`benchmark/${set.dir}/${file}`, 'utf8'));
      return entry?.status === 'complete' && Array.isArray(entry.ai) && entry.inputSha256 === sha256(text)
        && entry.ai.every(({ kind, quote }) => KINDS.includes(kind) && quote.trim() && text.includes(quote));
    }));
  const withAi = complete ? score(set, current, ai) : null;

  lines.push(`## ${set.name}`, '', `${after.files} files, ${after.strict} strict and ${after.ambiguous} ambiguous labels.`, '');
  lines.push(withAi ? '| | Labels | Before the rewrite | Current rules | Rules + AI |' : '| | Labels | Before the rewrite | Current rules |',
    withAi ? '| --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- |');
  for (const k of set.kinds ?? KINDS) lines.push(`| ${KIND_NAME[k]} | ${after.byKind[k].tp + after.byKind[k].fn} | ${earlier(set.dir, k)} | ${pair(after.byKind[k])} |${withAi ? ` ${pair(withAi.byKind[k])} |` : ''}`);
  if (!set.kinds) lines.push(`| Anything flagged (kind ignored) | ${after.any.tp + after.any.fn} | ${earlier(set.dir, 'any')} | ${pair(after.any)} |${withAi ? ` ${pair(withAi.any)} |` : ''}`);
  lines.push('');
  if (withAi) {
    const verified = entries.reduce((sum, entry) => sum + (entry.ai?.length ?? 0), 0);
    const rejected = entries.reduce((sum, entry) => sum + (entry.rejected ?? 0), 0);
    const rules = after.byKind.decision;
    const combined = withAi.byKind.decision;
    lines.push(`Model: ${aiRun?.model}. Decision counts for rules: ${decisionCounts(rules)}. Rules + AI: ${decisionCounts(combined)}. Across all kinds, ${verified} AI findings passed verification and ${rejected} were rejected. Ambiguous matches excluded: ${after.ignored} for rules and ${withAi.ignored} for rules + AI.`, '');
  } else if (set.kinds) {
    const d = after.byKind.decision;
    lines.push(`Current rules: ${d.tp} of ${d.tp + d.fn} decisions found, ${d.fp} false ${d.fp === 1 ? 'alarm' : 'alarms'}. Rules plus the AI pass: pending.`, '');
  }
  lines.push(`Current rules: ${after.findingsTotal} findings, ${after.ignored} of them matching an ambiguous label (not scored).`, '');
  lines.push('### Missed by the current rules', '', ...(after.misses.length ? after.misses.map((m) => `- ${m}`) : ['- none']), '');
  lines.push('### Wrong kind', '', ...(after.wrongKind.length ? after.wrongKind.map((m) => `- ${m}`) : ['- none']), '');
  lines.push('### False alarms', '', ...(after.falseAlarms.length ? after.falseAlarms.map((m) => `- ${m}`) : ['- none']), '');
  if (set.kinds) {
    const d = after.byKind.decision;
    summary.push(`${set.name}: decisions found ${d.tp}/${d.tp + d.fn}, false alarms ${d.fp}; precision / recall ${earlier(set.dir, 'decision')} before the rewrite → ${pair(d)}; rules + AI pass: ${withAi ? pair(withAi.byKind.decision) : 'pending'}`);
    continue;
  }
  summary.push(`${set.name}: anything flagged ${earlier(set.dir, 'any')} → ${pair(after.any)}; decisions ${earlier(set.dir, 'decision')} → ${pair(after.byKind.decision)} (precision / recall, before the rewrite → now)`);
}
lines.push('## Before and after the rewrite (counts)', '', 'Before = the counts published for the earlier rules (fixed numbers); now = the current rules. TP = true positives, FP = false positives (wrong kind counts as a false positive for the kind found), FN = misses. "Decisions" scores decision findings against decision labels; "Anything flagged" ignores kind. The recall set labels decisions only. Ambiguous matches are findings that matched an ambiguous label and are excluded.', '');
lines.push('| Set | Measure | Rules | TP | FP | FN | Precision / recall | Ambiguous matches excluded |', '| --- | --- | --- | ---: | ---: | ---: | --- | ---: |');
for (const set of SETS) {
  const r = score(set, current);
  const old = EARLIER[set.dir];
  const rows: Array<[string, 'decision' | 'any', Tally]> = [['Decisions', 'decision', r.byKind.decision]];
  if (!set.kinds) rows.push(['Anything flagged', 'any', r.any]);
  for (const [measure, key, t] of rows) {
    const c = old?.counts[key];
    if (c) lines.push(`| ${set.dir} | ${measure} | before | ${c[0]} | ${c[1]} | ${c[2]} | ${pair({ tp: c[0], fp: c[1], fn: c[2] })} | ${old.ambiguous} |`);
    lines.push(`| ${set.dir} | ${measure} | now | ${t.tp} | ${t.fp} | ${t.fn} | ${pair(t)} | ${r.ignored} |`);
  }
}
lines.push('');
lines.push('## Sources', '');
for (const set of SETS) {
  for (const [file, repo, path, sha] of readFileSync(`benchmark/${set.sources}`, 'utf8').trim().split('\n').map((l) => l.split('\t'))) {
    lines.push(`- \`${set.dir}/${file}\`: [${repo}/${path}](https://github.com/${repo}/blob/${sha}/${path}) at \`${sha.slice(0, 7)}\``);
  }
}
writeFileSync('benchmark/RESULTS.md', `${lines.join('\n')}\n`);
console.log(lines.slice(0, lines.indexOf('## Sources')).join('\n'));
console.log(summary.join('\n'));
