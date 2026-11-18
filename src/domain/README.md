# Domain module: decision extraction and issue matching

Pure TypeScript with no Forge calls, so it runs the same in a resolver, a test or the benchmark. The same input always gives the same output.

## Files

| File | What it does |
| --- | --- |
| `decisionTypes.ts` | The data shapes the resolvers, UI and stored records share. |
| `text.ts` | Splits source text into headings and sentences with exact character offsets. |
| `extractDecisions.ts` | The wording rules, input checks, `extractDecisions` and `verifyProposedFindings`. |
| `matchIssues.ts` | Which issues a finding may affect, and the wording a decision replaces (`extractChange`). |
| `fixtures/` | A fictional demo project, single-sentence cases, the checks and their golden output. |

Run the checks with `npm run test:domain`. After a deliberate rule change, run `node --import ./test/register.mjs src/domain/fixtures/checkFixtures.ts --update` and review the diff of `expectedDemoOutput.json`.

## Source text

Sources are plain text, one paragraph per line, as `src/resolvers/normalize.js` renders Confluence and Jira content:

- `## ` starts a heading;
- `- ` (or `* `, `1.`) starts a list item;
- Confluence decision items arrive as `Decision: …` lines.

A sentence ends at `.`, `!` or `?` followed by a space or the end of the line, so `3.5` and `file.ts` stay whole and `e.g.` ends a piece. `sourceLines` returns exactly these pieces, which is what the AI pass numbers, so a numbered sentence always verifies word for word. Typographic quotes and apostrophes are read as ASCII for matching, and quoted as written.

## What counts as what

Checked in this order. The first rule that applies decides.

1. **Labels.** `Decision:`, `Decided:`, `Agreed:`, `Resolved:`, `Conclusion:`, `Outcome:` or `Consensus:` at the start, followed by text (a short qualifier is allowed: "Decided in standup:") makes a decision. `Open question:` makes an open question, and `Proposal:` a proposal. Labels are never downgraded.
2. **Reference lines** such as `Attendees:`, `Agenda:` or rfcbot's `Tracking Comment:` are never findings. The sentence after a bare `Conclusion.` or `Outcome:` marker is a decision.
3. **Reversed** decisions ("was reversed", "was withdrawn") are dropped.
4. **Not decided yet** ("we have not decided whether…") is an open question.
5. **Questions** ending in `?` are open questions when they ask what to do and the next transcript line is not another speaker's answer. A reply that is itself a question does not count as an answer. Speaker lines may be list items (`- josh: …`). A question needs at least four words.
6. **Negated or conditional** wording is dropped: "we did not agree", "once we agree", "we will decide next week", "waiting for approval".
7. **Commitments** make a decision: "agreed to / that / on", "decided to / against", "it was agreed", "we settled on", "the group agrees", "there was consensus", "nobody objects", "was (already) approved", "we are approving". On a transcript line, a hedged view ("josh: I think we agreed…") is only a proposal.
8. **A list item under a decisions heading** (a heading with "decision", "outcome", "agreed" or "resolution") is a decision, and "we will …" counts as one in a decision record.
9. **Suggestions** make a proposal: "we should" (not after "if"), "I propose", "how about", "let's consider", "I think we need", "may be a better idea", "would like to see", "inclined to", "I think this warrants", "the proposal is to".

Confidence starts from the rule (0.85 for a label, 0.7 for commitment wording, lower for questions and suggestions). A decision gains 0.05 for a decision-like source title and 0.05 for sitting under a decisions heading, up to 0.95. It is a signal strength shown to people, not a probability.

## Issue matching

Each signal has a strength, and they combine as `1 − Π(1 − s)`, capped at 0.99:

| Signal | Strength | Reason shown |
| --- | --- | --- |
| The quote names the issue key | 0.9 | The decision names KEY |
| The same paragraph names it | 0.8 | The same paragraph as the decision lists KEY |
| The decision was written on that issue (description or comment) | 0.7 | The decision was recorded on KEY |
| The issue still uses wording the decision replaces | 0.85 | The issue still mentions “…”, which this decision replaces |
| The issue already uses the new wording, and not the old | 0.35 | The issue already uses the new wording “…” |
| Shared terms, weighted by how few issues share them | up to 0.6 | Shares terms with the issue: “a”, “b”, … |

Shared terms are stemmed, stop words are removed, and at least two must match. Two words side by side in both texts ("guest checkout") add weight. A match needs relevance 0.3, or 0.4 when shared terms are the only signal. At most five issues are kept per finding, strongest first.

`extractChange` reads the replaced wording from "X instead of Y", "X rather than Y", "replace Y with X", "move / switch / change / migrate from Y to X", "Y is out of scope", "no longer Y" and "stop Y". Phrases lose leading articles and possessives, end before a new clause ("legacy card form | for checkout"), and have at most six words.

## Ids

`stableId(sourceId, summary)` is `dc_` plus two 32-bit FNV-1a hashes (16 hex digits) of the source id and the lower-cased summary. The same sentence keeps its id when it moves on the page, so reviews, notes and drift history stay attached.

## Checking a model's proposals

`verifyProposedFindings` accepts a proposal only when its quote is one or more whole sentences found word for word in that source (typographic quotes may differ), is at most 280 characters, has a valid kind, is not a reference line or a negated or reversed decision, and does not overlap a finding already known. Accepted findings get the same shape and issue matching as rule findings.
