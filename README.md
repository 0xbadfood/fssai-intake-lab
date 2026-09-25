# FSSAI intake lab

An experiment to rebuild the portal's intake as a **fixed automaton plus a growing knowledge graph**. The background is in `~/fssai-portal/automata-next.md`, the design in `DESIGN.md`, and the plan in `~/fssai-portal/TODO.md` under "Intake engine". There is no UI; this CLI is the front end. Nothing in the portal changes until the lab has proved itself.

## Status

**M1 is done (2026-09-25).** `graph/graph.v1.json` plus `engine/` reproduce the live portal's intake exactly:

- all **17,574** tap paths match, with the same verdict split: deemed 1,398, Registration 3,690, State 3,642, Central 8,838, not food 6;
- at every step, the rendered question (title, hint, options with labels and examples) and the facts are identical to the portal's own code, run side by side;
- at the end of every path, the verdict, form (A/B) and summary rows are identical;
- about 600,000 typed-answer merges (`--merge-every 1`), including a malformed interpretation seen in production, are identical;
- 10 mutation tests change one thing in the graph each, and the parity walk catches every one.

**M2 is done (2026-09-25).** `graph/graph.v2.json` models licensing by FoSCoS Kind of Business, from the 2026 eligibility table and the March 2021 document list:

- **Kinds of business:** 39 (17 manufacturing, 12 trade, 10 food service), plus Head Office, each with `is_a` links, a licence rule (fixed, or turnover bands with fees), its documents, and a quote from the table that `check` verifies;
- **Place rules:** airport/seaport, railway station and central-government premises (with Central Registration and the ₹2,000 Central Licence). The higher licence always wins, so a place never lowers a Central-only kind;
- **Turnover** is asked only when the answer could change the result;
- **Multi-state:** a multi-state business gets this premises' own verdict plus a Central Head Office task, and several places add an "another premises" task;
- **Expert handover:** "not sure" answers and cases the table does not cover give a likely result with an expert option;
- **Checks:** all 251,564 walked paths pass every invariant (`check --graph graph/graph.v2.json`, ~3 min), and 27 scenario cases pass (`cases --graph graph/graph.v2.json`), including the portal's known errors with their correct answers.

v1 is a **regression baseline, not correct licensing**. It carries the portal's known errors (State fee, missing "always Central" kinds of business, caterer and hotel bands). Those are fixed in v2, which is built from the FoSCoS 2026 eligibility table (`sources/`).

## Commands

```bash
node cli/lab.mjs check                         # validate the graph, walk every path, check invariants
node cli/lab.mjs walk --parity [PORTAL_DIR]    # plus lockstep comparison with the portal (default ../fssai-portal)
node cli/lab.mjs walk --parity --merge-every 1 # compare typed merges at every step (~75 s)
node cli/lab.mjs walk --tree                   # print the first levels of the path tree with counts
node cli/lab.mjs ask                           # answer interactively (numbers for taps; also works with piped input)
node cli/lab.mjs explain '{"activities":["import"],"place":"premises"}'   # verdict + the edges and sources behind it
node cli/lab.mjs cases --graph graph/graph.v2.json   # scenario cases (tests/cases.v2.json)
node cli/lab.mjs check --graph graph/graph.v2.json   # v2: every activity pair, kind pairs for one activity (--pick N)
npm test                                       # unit, parity and mutation tests (~1 min)
```

Every command takes `--graph FILE` to run another graph version.

## Layout

```
DESIGN.md            the design (step 1) and decisions
graph/graph.v1.json  parity port of the portal (facts, values, defs, edges, verdict, assertions)
graph/graph.v2.json  FoSCoS kinds of business: concepts, place rules, band sets, fees, documents, tasks
engine/              pure JS, no DB or network: conditions, text templates, graph validation, automaton, verdict
cli/                 lab.mjs (commands), walk.js (path walker + portal adapter), cases.js (scenario runner)
tests/               node:test suite; cases.v2.json scenario cases
tools/transcribe.py  scanned PDF pages → Markdown with the local Qwen vision model (:7001)
sources/             FoSCoS eligibility table, guidance document, foscos/ (index, text, OCR, vision transcripts)
```

## Rules of the lab

- The live portal instance (`fssai.photovault.live`) is shared with the user's own testing: never reset it.
- Never use `10.8.0.5` (production document checker). The local model is `:7001`; Spark is `10.8.0.4`.
- Graph releases are immutable: any change is a new version, and `check` plus `walk` must pass on it.
