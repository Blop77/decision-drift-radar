/**
 * Checks for the domain module: the wording rules, the change rules, issue matching, input
 * warnings, verification of model proposals, and the golden output for the demo project.
 * Run with `npm run test:domain`; pass `--update` to rewrite expectedDemoOutput.json after a
 * deliberate rule change (and review the diff).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_QUOTE_LENGTH, extractDecisions, sourceLines, stableId, verifyProposedFindings } from '../extractDecisions.ts';
import { extractChange, issueStillMentions } from '../matchIssues.ts';
import type { SourceRecord } from '../decisionTypes.ts';
import { demoInput, demoIssues, demoSources } from './demoInput.ts';
import { changeCases, sentenceCases } from './edgeCases.ts';

const GOLDEN = fileURLToPath(new URL('./expectedDemoOutput.json', import.meta.url));

const page = (text: string, title = 'Team notes', id = 'p1'): SourceRecord => ({
  id, type: 'confluence_page', title, url: '', projectKey: 'FS', updatedAt: '2026-11-01T00:00:00Z', text
});

test('each wording rule gives the expected kind', () => {
  for (const c of sentenceCases) {
    const text = [...(c.before ?? []), c.text, ...(c.after ?? [])].join('\n');
    const { candidates } = extractDecisions({ sources: [page(text, c.title)], issues: [] });
    const quote = c.text.replace(/^- /, '');
    const found = candidates.find((x) => x.evidence.quote === quote);
    assert.equal(found?.kind ?? null, c.expect, `${c.rule}: “${c.text}”`);
  }
});

test('change rules find the old and new wording', () => {
  for (const c of changeCases) assert.deepEqual(extractChange(c.text), c.expect, c.text);
});

test('issueStillMentions ignores case and spacing but respects word boundaries', () => {
  const issue = { title: 'Weekly  Digest', description: 'Sent on Mondays.' };
  assert.equal(issueStillMentions(issue, 'weekly digest'), true);
  assert.equal(issueStillMentions(issue, 'on mondays'), true);
  assert.equal(issueStillMentions(issue, 'Monday'), false);
  assert.equal(issueStillMentions(issue, ''), false);
  assert.equal(issueStillMentions(null, 'weekly'), false);
});

test('evidence is exact, ids are stable, and summaries drop the label', () => {
  const { candidates } = extractDecisions(demoInput);
  for (const c of candidates) {
    const source = demoSources.find((s) => s.id === c.source.id)!;
    assert.equal(source.text.slice(c.evidence.start, c.evidence.end), c.evidence.quote);
    assert.ok(c.evidence.quote.length <= MAX_QUOTE_LENGTH);
    assert.match(c.id, /^dc_[0-9a-f]{16}$/);
    assert.equal(c.id, stableId(c.source.id, c.summary));
    assert.ok(!('text' in c.source));
    assert.ok(c.confidence > 0 && c.confidence <= 1);
    assert.ok(c.affectedIssues.length <= 5);
  }
  assert.ok(candidates.every((c) => !/^(Decision|Agreed|Open question):/.test(c.summary)));
  // The same sentence elsewhere on the page keeps its id.
  const moved = extractDecisions({ sources: [{ ...demoSources[0], text: `New intro line.\n${demoSources[0].text}` }], issues: demoIssues });
  assert.deepEqual(moved.candidates.map((c) => c.id), candidates.filter((c) => c.source.id === demoSources[0].id).map((c) => c.id));
});

test('the user-facing reason strings keep their wording', () => {
  const { candidates } = extractDecisions(demoInput);
  const reasons = candidates.flatMap((c) => [...c.confidenceReasons, ...c.affectedIssues.flatMap((a) => a.reasons)]);
  assert.ok(reasons.includes('Starts with a "Decision:" label'));
  assert.ok(reasons.includes('Source title suggests a decision record'));
  assert.ok(reasons.includes('Listed under a decisions heading'));
  assert.ok(reasons.includes('The issue still mentions “by technician seniority”, which this decision replaces'));
  assert.ok(reasons.some((r) => /^Shares terms with the issue: “[^”]+”(, “[^”]+”)*$/.test(r)));
  const paragraph = extractDecisions({ sources: [page('Related: FS-16. Decision: Plants are watered on Fridays.')], issues: demoIssues });
  assert.ok(paragraph.candidates[0].affectedIssues.some((a) => a.reasons.includes('The same paragraph as the decision lists FS-16')));
});

test('bad input becomes warnings, never an error', () => {
  assert.deepEqual(extractDecisions(null as any).warnings.map((w) => w.code), ['invalid_input']);
  assert.deepEqual(extractDecisions({ sources: [], issues: [] }).warnings.map((w) => w.code), ['empty_input']);
  const { warnings } = extractDecisions({
    sources: [page('Decision: A.'), page('Decision: B.'), { ...page('x'), id: '' }, { ...page('Decision: C.', 'T', 'p2'), updatedAt: 'yesterday' }],
    issues: [demoIssues[0], demoIssues[0], { ...demoIssues[1], key: 'not a key' }],
    maxCandidates: 0
  });
  assert.deepEqual(warnings.map((w) => w.code).sort(), ['duplicate_issue', 'duplicate_source', 'invalid_issue', 'invalid_option', 'invalid_source', 'invalid_timestamp']);
});

test('results are capped, with a warning', () => {
  const text = Array.from({ length: 8 }, (_, i) => `Decision: Rule number ${i + 1} applies.`).join('\n');
  const { candidates, warnings } = extractDecisions({ sources: [page(text)], issues: [], maxCandidates: 3 });
  assert.equal(candidates.length, 3);
  assert.equal(warnings.at(-1)?.code, 'candidates_truncated');
});

test('sourceLines gives headings and sentences with exact offsets', () => {
  const text = '## Plan\n- First step. Second step!\nVersion 2.5 ships e.g. next week.';
  const lines = sourceLines(text);
  assert.deepEqual(lines[0], { heading: 'Plan' });
  for (const line of lines.slice(1)) {
    if ('sentence' in line) assert.equal(text.slice(line.start, line.end), line.sentence);
  }
  assert.deepEqual(lines.slice(1).map((l: any) => [l.sentence, l.listItem]), [
    ['First step.', true], ['Second step!', true], ['Version 2.5 ships e.g.', false], ['next week.', false]
  ]);
});

test('a model proposal is accepted only as whole sentences, word for word', () => {
  const source = page('Intro line. After the review, the team’s going ahead with Tuesday sends. We did not approve the budget.');
  const input = { sources: [source], issues: [] };
  const ok = verifyProposedFindings(input, [{ sourceId: 'p1', quote: "After the review, the team's going ahead with Tuesday sends.", kind: 'decision' }]);
  assert.equal(ok.candidates.length, 1, 'typographic apostrophes may differ');
  assert.equal(ok.candidates[0].evidence.quote, 'After the review, the team’s going ahead with Tuesday sends.', 'the stored quote is the source text');
  const bad = verifyProposedFindings(input, [
    { sourceId: 'p1', quote: 'the team’s going ahead', kind: 'decision' },
    { sourceId: 'p1', quote: 'We did not approve the budget.', kind: 'decision' },
    { sourceId: 'p1', quote: 'Intro line.', kind: 'verdict' as any },
    { sourceId: 'nope', quote: 'Intro line.', kind: 'proposal' },
    { sourceId: 'p1', quote: 'x'.repeat(MAX_QUOTE_LENGTH + 1), kind: 'proposal' }
  ]);
  assert.deepEqual(bad, { candidates: [], rejected: 5 });
  const known = ok.candidates;
  assert.equal(verifyProposedFindings(input, [{ sourceId: 'p1', quote: known[0].evidence.quote, kind: 'decision' }], known).rejected, 1, 'overlaps a known finding');
});

test('a custom classifier replaces the built-in rules', () => {
  const { candidates } = extractDecisions({ sources: [page('Lunch is at noon.')], issues: [] }, {
    classifier: () => ({ kind: 'proposal', confidence: 0.4, reasons: ['test'] })
  });
  assert.deepEqual(candidates.map((c) => [c.kind, c.confidenceReasons]), [['proposal', ['test']]]);
});

test('the demo project matches the golden output', () => {
  const actual = extractDecisions(demoInput);
  if (process.argv.includes('--update')) {
    writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  assert.deepEqual(actual, JSON.parse(readFileSync(GOLDEN, 'utf8')));
});
