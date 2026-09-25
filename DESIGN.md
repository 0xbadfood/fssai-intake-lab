# Intake lab — step 1 design: automaton, graph, records

Status: reviewed 2026-09-25 (decisions in §11). **M1 done:** the engine and `graph/graph.v1.json` match the portal on all 17,574 paths (see README.md).
Context: `~/fssai-portal/automata-next.md` (why), `~/fssai-portal/TODO.md` → "Intake engine" (plan).

This lab is a separate project. It must prove itself here before anything changes in the portal. It has no UI; the only front end is a CLI.

## 1. The pieces

| Piece | What it is | Who changes it |
|---|---|---|
| **Graph** | Versioned JSON with what we know about food businesses: concepts, the facts to ask, and how they lead to a licence. | Grows often: the LLM loop drafts, then reviewers and experts approve. |
| **Automaton** | A small, fixed set of conversation states. It reads the graph to decide what to ask next. | Rarely changes. |
| **Verdict** | Deterministic rules over facts and graph edges that produce the licence and its reasons. | Only through graph edges. No model is involved. |
| **Records** | Interpreted answers in one shared shape. The automaton looks them up, CLM trains on them, and steps 2 and 3 produce them. | Appended by the cache ingestion (step 2) and the LLM loop (step 3). |
| **Engine** | Pure JS modules (no DB, no network) that load the graph, run the automaton and compute the verdict. | Code, written once. |
| **CLI** | `lab check`, `lab walk`, `lab ask`, `lab explain`. | Code. |

The engine stays in JS/ESM so it can later move into `fssai-portal/server` unchanged.

## 2. Graph format

One file per version: `graph/graph.vN.json`. Once a version is released it is never edited; any change produces N+1.

```jsonc
{
  "version": 1,
  "facts":    [ /* slots the conversation fills */ ],
  "concepts": [ /* things a user's words can match */ ],
  "edges":    [ /* relations between concepts, facts and outcomes */ ],
  "outcomes": [ /* licences and terminal results */ ],
  "documents":[ /* required documents */ ]
}
```

### 2.1 Facts (the slots)

A fact is what today's `RAW` question fills.

```jsonc
{ "id": "place", "type": "enum",               // enum | multi | bool | number | states
  "order": 40,                                   // ask order among facts that are due
  "title": "Where do you run it from?",          // may have variants chosen by a condition
  "values": [
    { "id": "street", "label": "A cart, stall or food truck", "example": "Chaat cart, tea stall",
      "when": { "all": [ { "only": ["activities", ["cook", "sell"]] }, { "only": ["trade", ["retail"]] } ] } },
    { "id": "vehicles", "label": "Only my vehicles",
      "when": { "all": [ { "eq": ["activities", ["sell"]] }, { "eq": ["trade", ["transport"]] } ] } }
  ],
  "relevant": { "matched": "food_business" } }
```

- A value's `when` replaces today's option filters, such as `outletOnly` and `transportOnly`.
- A fact is **due** when it is relevant, unanswered and not implied, **and** it is needed. It is needed when it is global (`state`, `locations`) or when some matched concept has a `needs` edge to it.

### 2.2 Concepts (what text matches)

```jsonc
{ "id": "cloud_kitchen", "kind": "business",   // activity | trade | place | business
  "label": "Cloud kitchen",
  "desc": "Cooks food only for delivery, usually through Swiggy or Zomato; no dine-in.",
  "aliases": ["cloud kitchen", "dark kitchen", "delivery kitchen"],   // feed the rules layer (lexicon)
  "status": "expert",                           // draft | model-reviewed | expert
  "sources": [ { "doc": "fssai_de70d5ce6eeb2647e32d", "page": 12, "quote": "…" } ],
  "added_in": 1 }
```

- **activity** concepts are the four buckets we have today: `cook`, `make`, `sell` and `import`.
- **business** concepts are the new layer: cloud kitchen, dairy processor, exporter, nutraceutical maker. They are what users actually say, so they are what CLM matches. Each one links to activities through `is_a` edges, so the verdict rules never need to know about it directly.
- `desc`, `label` and `aliases` together are the concept's "action text" for CLM (§5).

### 2.2a Sources and trust levels

Every source entry is `{ "level", "doc" | "url", "page"?, "quote", "fetched_at"?, "sha256" }`. The `quote` must appear verbatim in the saved text. `lab check` verifies this for level A, and the reviewer verifies it for level B.

| Level | Source | May support |
|---|---|---|
| **A** | The frozen `~/fssai` corpus (`data/catalog.jsonl`, page text in `data/text`), cited by `document_id` + page | Any edge. An edge needs a level A source to reach `expert`; `forces` and `threshold` edges need one to count in a final verdict. |
| **B** | Pages fetched from allowlisted official domains (`fssai.gov.in`, `foscos.fssai.gov.in`, `egazette.gov.in`) | `draft` edges only. The document is then added to the corpus through the `~/fssai` collection pipeline, which makes it level A, and the edge is re-cited. |
| **C** | The general web (news, consultants, blogs) | Concept `desc`, `aliases` and phrasings only. **Never** a licence, threshold or document edge. |

- The planner searches the corpus first and uses the web only when the corpus has nothing.
- Web research uses `~/kbagent` (Tavily + Obscura on the `:7001` model), adapted as described in the TODO.
- Only queries the planner writes go to Tavily, which is an external service. User text from records never does.
- **Primary licensing source: the FoSCoS eligibility table.** The `~/fssai` corpus holds laws and regulations but nothing direct about licensing. FoSCoS publishes that separately. The key document is `sources/KindofBusinessEligibility-2026-04-02.pdf` (FoSCoS `assets/docs/Revised_2ndApril2026KindofBusinessEligibility.pdf`; 9 pages, "Updated on 01.04.2026"; sha256 `d066f7e7…668c85`; text beside it). Every kind of business is listed with its licence by turnover band (≤ ₹1.5 Cr / ₹1.5–50 Cr / > ₹50 Cr) and its annual fee. **It seeds the `business` concepts and their `forces`/`threshold` edges.** It is level B until it is added to the `~/fssai` corpus. The other FoSCoS manuals (how to apply as an exporter, importer, e-commerce business, restaurant or manufacturer; the nutraceutical guidance; the list of documents required; the head-office manual) are listed in `sources/foscos-assets.txt`. The `/user-manual` page itself only renders with JavaScript; the list was taken from its app bundle.
- **What the table shows that today's portal logic does not:**
  - **No turnover threshold, always Central:** importer, e-commerce, trader/merchant exporter, exporter–manufacturer, 100% EOU, proprietary food, food or health supplements and nutraceuticals, non-specified food and ingredients, Ayurveda aahara, radiation processing. Today's code forces Central only for importers and e-commerce.
  - **Different bands:**
    - Caterer: State up to ₹50 Cr, Central above, with **no Registration band**.
    - Club or canteen: State above ₹1.5 Cr, with no Central band.
    - Hotel: by star rating (five-star → Central, up to four-star → State, ≤ ₹1.5 Cr → Registration).
    - Petty retailer of snacks or tea, and hawker: Registration only.
    - Petty milkman or milk vendor: Registration.
  - **Fees:** State Licence is **₹5,000** a year for every kind of business in the table, against ₹2,000 in `applicationPlan.js` `GOVT_FEE_PER_YEAR`. Hawkers pay ₹0 (fee waived from 28.09.2024).
- **Guiding document: FoSCoS Guidance Document V1.0** (March 2020, 37 pages). `sources/FoSCoSGuidanceDocumentV1_0_Latest.pdf` is the one to cite. The other file, `…V1.0.pdf`, differs only in a few FAQ answers and dates. Both are saved with their text. Use it for **structure and process, not numbers**; the 2026 table overrides its thresholds and fees. What it tells the graph design:
  - **The FoSCoS Kind of Business (KoB) list is the backbone.** On FoSCoS a business picks a KoB from the groups Manufacturer, Trade/Retail and Food Services. Our `business` concepts should map one to one onto FoSCoS KoBs, so a verdict also tells the ops team which KoB to select when filing.
  - **Head office is its own KoB,** not a question: *"Head Office is now made as a separate KoB."* Our multi-state case becomes a `head_office` concept, not a flag.
  - **Manufacturers must pick the specific KoB.** Dairy, oil, meat, proprietary, nutraceutical and non-specified/novel food each have their own KoB. "General manufacturing" covers only what is left over (FAQ 6.2 Q3, Q5). So `make` needs a `product_type` fact before the verdict.
  - **Manufacturers choose products** (the "product selection approach", §5, using food category numbers such as category 100 and the proprietary-food fallback for categories 15 and 16). For caterers only a broad product category is needed (Q4). This affects the details step later, not the licence.
  - **Documents are listed per KoB** (instead of the old full set of 29). So `requires_doc` edges hang off `business` concepts. The document list itself is `DocumentListMarch.pdf` (in `foscos-assets.txt`).
  - **Petty businesses have a guest-login path** for Registration (§4.2.1). It's worth noting as a lighter filing route.
- **The full FoSCoS manual set** (80 files: user manuals, guidance, orders, presentations; cached from the `/user-manual` hub on 2026-09-25) is in `~/fssai-portal/documents/`, with a `README.md` index. That folder is left untouched. The lab keeps derived text under `sources/foscos/`:
  - `index.tsv`: file, pages, words and sha256 for all 71 PDFs;
  - `text/`: `pdftotext` output. Most manuals are mainly screenshots of the FoSCoS forms, at 100–500 words each;
  - `vision/`: page-by-page Markdown made with `tools/transcribe.py`, which uses the local Qwen vision model on `:7001`, one page at a time, at temperature 0, with the source sha256 recorded. It reads scanned tables accurately (about 5 s a page), where Tesseract (`ocr/`) garbles them. Numbers in a vision transcript are checked against the page image before an edge that depends on them becomes `expert`.
- **The document list for each kind of business: `vision/documentlistmarch.md`.** This is FSSAI order 15(31)2020/FoSCoS/RCD, March 2021, and it is the source for the `requires_doc` edges.
  - **A1: common documents for non-manufacturers** (1–5).
  - **A2: extra documents by kind of business:**
    - food service: water analysis report;
    - importer: IEC and recall plan;
    - merchant exporter: IEC and an export-only declaration;
    - head office or e-commerce: recall plan;
    - transporter: vehicle registration numbers.
  - **B1: common documents for manufacturers** (1–10).
  - **B2: extra documents by type of manufacturing:** dairy, meat, slaughter house, relabeller or repacker, nutraceuticals, proprietary food, novel food, packaged drinking water.
  - Registration needs only a photo, a photo ID and proof of address (`vision/documentsrequiredforregistrationcertificate.md`).
  - The screenshot manuals (for example how to apply as an exporter, importer or for e-commerce) can be transcribed the same way when the planner needs them; they show FoSCoS's own form fields and kind-of-business choices.
- **Effect on milestones:** `graph.v1` stays an exact port of today's logic (a regression baseline), and `graph.v2` is built from this table with the differences above as its first test cases.

### 2.3 Edges

`{ "id", "from", "rel", "to", "when"?, "status", "sources" }`

| rel | from → to | meaning | today's code |
|---|---|---|---|
| `is_a` | concept → concept | cloud_kitchen is_a cook (transitive) | `sanitizeFacts` kob ↔ activities |
| `sets` | concept → fact=value | cloud_kitchen sets place=premises (a default the user can change) | LLM prompt hints |
| `needs` | concept → fact | dairy needs milk_litres_per_day | — (new) |
| `implies` | condition → fact=value | place=home implies locations=one | `RULES` kind `implied` |
| `unlikely` | condition → confirm | place=street and turnover>1.5 | `RULES` kind `unlikely` |
| `forces` | concept or condition → outcome | import forces central | `hasCentralOverride` |
| `threshold` | numeric fact → outcome bands | turnover ≤1.5 → registration, ≤50 → state, else central | `checkEligibility` step 3 |
| `requires_doc` | concept/condition → document | import requires IEC | `requiredDocuments` |
| `note` | condition → text | several places → one approval each | `eligibilityFromFacts` notes |

### 2.4 Conditions

This is a small JSON expression language, evaluated by `engine/conditions.js`. Graph files contain no functions.

`all`, `any`, `not`, `eq [fact, value]`, `has [fact, value]` (list contains), `only [fact, values]` (list ⊆ values), `in [fact, values]`, `gt`/`lte [fact, n]`, `known fact`, `matched concept` (the concept or anything that `is_a` it is matched).

Adding an operator is a code change. That is deliberate: the operator set should stay small.

### 2.5 Invariants (checked by `lab check`; a graph that fails any of them is not released)

1. The file matches the schema, IDs are unique, and every reference resolves.
2. `is_a` and `forces` edges have no cycles.
3. Walking every path reaches exactly one verdict or the expert handover, never none and never two conflicting ones.
4. Every fact is reachable, and every value of an enum fact is offered on at least one path.
5. Today's `FORBIDDEN` list carries over as graph assertions. For example, a street cart is never offered to a manufacturer.
6. Only an edge with status `expert` can `force` a licence in a final verdict. A `draft` edge marks the verdict provisional (§3.3).
7. **Parity:** `graph.v1` reproduces today's automaton exactly: the same paths, verdict counts and question order as `scripts/check-intake.mjs` on the portal code. This is milestone M1's acceptance test.

## 3. Automaton

### 3.1 The state is derived from facts alone

As today, the conversation state is a pure function: `step = nextStep(graph, facts)`. There is no hidden state, so an application can be resumed, replayed or audited. Each application stores `graph_version`, and an open application keeps the version it started with.

### 3.2 States

| State | Enters when | Does |
|---|---|---|
| `ASK` | a fact is due | Renders the fact's title and the values allowed under the current facts |
| `INTERPRET` | the user typed text instead of tapping | Runs the layered matcher (§6) and returns targets with confidence |
| `CLARIFY` | the matcher is unsure, or two candidates are close | Offers the top candidates as taps, plus "none of these" |
| `CHECK` | a contradiction, a broken implication or an unconfirmed `unlikely` | Same as today's `CHECK`: keep, change or confirm |
| `HANDOVER` | the text reaches no known concept, the user picks "none of these" twice, or a verdict depends on a `draft` edge | Tells the user honestly that an expert will confirm, and logs an `unknown` record |
| `NOT_FOOD` | the user says no food activity and confirms a non-food reason | Terminal, same as today |
| `VERDICT` | no fact is due and there are no open checks | Runs the verdict rules (§3.3) |

Transitions: `ASK → (tap) → CHECK? → ASK | VERDICT`; `ASK → (text) → INTERPRET → CLARIFY | CHECK | ASK | HANDOVER`. Under the lab policy (`handover: "offer"`), `HANDOVER` does not end the conversation: the user can continue with taps and the case stays flagged. The live portal may set `handover: "force"`, which ends at the expert (§11.2).

### 3.3 The verdict

The verdict is fixed code and reads only facts and edges:

1. **Not food** → no approval needed.
2. **Deemed:** a registered street vendor (with the opt-in path, as today).
3. **Forced:** collect every `forces` edge whose source is matched or whose condition holds, and take the highest licence (Central > State > Registration).
4. **Thresholds:** evaluate each `threshold` edge whose fact is known, and take the highest.
5. **Result:** the higher of 3 and 4. When nothing applies, the default is Registration.
6. Add the `note` edges and the `requires_doc` edges.

Every verdict comes with its **trail**: the edge IDs and sources that fired. `lab explain` prints the trail. The verdict is marked `provisional: true` when any edge on the trail is not `expert`. A provisional verdict is still shown as the likely result, with an option for an expert to confirm it (§11.3).

Capacity thresholds (milk, meat, oil and so on) are added only as sourced edges. No numbers are written from memory.

## 4. Interpretation records (the shared contract)

This is one JSONL line per interpreted answer, and the same shape comes from every producer.

```jsonc
{
  "id": "sha256(step|candidates_sig|text_norm)",
  "step": "place",                       // fact id, or "business" for the free-text description
  "candidates": ["street","home","premises"],    // what was on offer; CLM negatives come from here
  "candidates_sig": "g1:street,home,premises",
  "known_facts": { "activities": ["cook"] },     // context the answer was given in
  "text": "ghar se hi banate hai",
  "text_norm": "ghar se hi banate hai",
  "token_sig": "banate ghar",
  "lang": "hi-Latn",                     // en | hi-Latn | hi | mixed
  "targets": ["home"],                   // concept or value ids; [] with unknown=true for no-match
  "negatives": ["premises"],             // hard negatives: plausible but wrong
  "unknown": false,
  "facts": { "place": "home" },          // extra facts stated in passing (sanitised)
  "source": "llm-loop",                  // prod-cache | llm-loop | rule | human
  "producer": { "model": "qwen3.8-27b", "prompt": "loop-v1", "reviewer": "qwen3.8-flash-next" },
  "graph_version": 1,
  "status": "model-reviewed",            // draft | model-reviewed | expert | rejected
  "split": "train",                      // train | dev | test   (prod-cache → test by default)
  "pii": false,
  "created_at": "2026-09-25T12:00:00Z"
}
```

- **The automaton** looks up `(step, candidates_sig, text_norm | token_sig)` and uses the record only when its status is `model-reviewed` or higher. That covers exact and reworded matches, as the cache does today.
- **CLM** turns each record into training examples (§5).
- **The portal's cache** later becomes a table of these records. The mapping from today's `intake_answer_cache` columns is direct: `question_id → step`, `options_sig → candidates_sig`, and `result.choice → targets`.

## 5. How CLM consumes records

- **State text:** `Question: <fact title>. Known: <known_facts in words>. Answer: "<text>"`
- **Action text** for each candidate: `<label> — <desc>. e.g. <aliases/examples>`
- **An extra action** at every step: `None of these — the answer describes something not listed`. Records with `unknown: true` train it.
- **Positives** are `targets`. **Hard negatives** are `negatives` plus the other `candidates`.
- **Test set:** only `split: test`, which is real user text. We never train on it.

## 6. Interpreting typed text (runtime layers)

1. **Rules:** aliases from the graph plus `LEXICON`, used only when every meaningful word is explained (as in today's `answerRules.js`).
2. **Records:** reviewed records, exact then reworded.
3. **Matcher:** CLM, added later. Below the threshold, or when "none" wins, the answer goes to `CLARIFY`/`HANDOVER`.
4. **LLM:** the base 27B model. Its output is filtered to the offered candidates and saved as a `draft` record. A draft is never reused until it has been reviewed.

## 7. What the current code becomes

| Today (`src/lib/…`) | In the lab |
|---|---|
| `RAW` questions and `apply`/`value`/`show` | `facts` with `values` |
| `options(f)` filters (`outletOnly`, `premisesOption`) | value `when` conditions, with labels chosen by condition |
| `RULES` (`implied`, `unlikely`) | `implies` and `unlikely` edges |
| `CHECK`, `divergences`, `reconcile`, `mergeInterpretation` | engine code (the same logic, reading edges) |
| `hasCentralOverride` and `checkEligibility` | `forces` and `threshold` edges plus the §3.3 verdict |
| `eligibilityFromFacts` notes | `note` edges |
| `LEXICON` | concept and value `aliases` |
| `check-intake.mjs` `FORBIDDEN` | graph assertions checked by `lab check` |

## 8. Layout

```
fssai-intake-lab/
  DESIGN.md
  graph/        graph.v1.json (parity), graph.v2.json (+ exporter, nutraceutical)
  engine/       graph.js (load + validate), conditions.js, automaton.js, verdict.js, match.js
  records/      prod/  loop/  reviewed/      (JSONL, append-only)
  cli/          lab.mjs  → check | walk | ask | explain
  tests/
```

## 9. Milestones

- **M1: parity. Done 2026-09-25.** The engine plus `graph.v1` match the portal's `check-intake.mjs` path for path. They were checked in lockstep with the portal's own code: every rendered question, all facts, verdicts, forms and summaries, and ~600k typed merges. Ten mutation tests confirm the check catches differences.
- **M2: v2 from the FoSCoS table. Done 2026-09-25.** `graph.v2` covers the kinds of business, place rules, fees, documents, tasks and handover (see "As built in v2"). All 251,564 walked paths pass the invariants, and 27 scenario cases pass, including the portal's known errors with the FoSCoS answers. **Open questions for the expert review** (all edges are `draft`):
  - unrated hotels above ₹1.5 Cr (State assumed);
  - small grain, cereal and pulse mills (State assumed, from the table's "without any limit on turnover threshold");
  - non-food-service activities at railway stations (handover);
  - several kinds of business on one premises (the highest licence wins);
  - petty milkmen (the table's note is not modelled);
  - deemed registration for street vendors with a municipal certificate (kept from the portal's workflow; it is not in the table).
- **M3: step 2.** Convert `intake_answer_cache` into records.
- **M4: step 3.** The LLM loop writes records for each step, including unknowns. **Pilot done 2026-09-25** (`loop/`, `records/loop/pilot-2/REPORT.md`):
  - **Scope:** activity, food-service and manufacturing steps, 12 answers per option plus 15 no-match per step, 338 answers.
  - **Method:** the planner (local 27B) writes answers in 7 styles (short, sentence, Hinglish, Devanagari Hindi, typos, indirect, detailed). Spark and the local model then classify each one **blind**, with a JSON schema enforced by grammar. An answer is kept when Spark matches the intent. It is relabelled when both blind classifiers agree with high confidence on another option.
  - **Results:** 95% of answers kept; 96% of no-match answers recognised; 0 errors; 29 records a minute; mean within-option word overlap 0.04. A spot check of 60 found about 92–97% correct.
  - **Pilot 1 lessons:**
    - Spark (llama.cpp, one slot) ignores plain JSON mode on some Hindi input, so the schema is required.
    - A retry must change the sampling.
    - The planner's own "none" answers were often real matches, so the no-match prompt must forbid listed activities.
    - Spark catches about 2.5% of answers that the local model passes. They are the genuinely ambiguous ones, so it stays on every answer.
  - **Full run done 2026-09-25** (`records/loop/full-1/`): 10 views (activity, the four "which kind?" questions, place in four contexts, online), 40 answers per option in 4 persona rounds, plus combined answers and no-match. **2,237 of 2,331 kept (96%): 2,045 train, 192 dev, 257 no-match, 1,174 with hard negatives, 119 relabelled.** 0 errors, 75 min, 30 records/min. Languages: 1,420 English, 554 Hinglish, 302 Devanagari. Combined answers are the hardest (4–6 of 8 kept). Makers and exporters who also sell their own goods get read as make + sell or export + make (expert query D9).
  - **Confusable pairs**, for the expert and as CLM hard negatives: proprietary/general, novel/nutraceutical, slaughter/meat, mid-day-meal canteen/canteen, caterer/vending establishment. Also: pet food is outside FSSAI.
- Then the CLM experiment.

### As built in v1 (differences from §2's sketch)

- A graph `fact` is a **question**. It owns one or more fact `keys` (`activity` owns `activities`, `kob` and `importer`). The key schema is a separate `keys` list, used to clean untrusted input, with `keep` rules (for example, `trade` only when selling) and `derive` rules (`kob`, `importer`).
- **Named conditions** live in `defs` (`outletOnly`, `centralOverride`, …) and are used with `{ "ref": … }`. A `{ "len": key }` operand counts list items.
- **Templates** for titles, labels and examples are `cases` (the first match wins) or `parts` (the ones that apply, joined, with a prefix or an "or" list). An option's `show` gives its summary text.
- Besides the edge types in §2.3, v1 uses **`outcome`** (not food, deemed with opt-in) and **`reason`** edges (for example, an unregistered street vendor). Licence names, their order and the forced-licence text are in `verdict`.
- The **`assertions`** replace `check-intake.mjs`'s `FORBIDDEN` list. `lab check` fails if any path ends in a forbidden combination (`"verdict": true` assertions also see the chosen licence as `$licence`).
- Edge **sources** are checked by `lab check`: the quote must appear on the cited page of the saved text, and `expert` status needs a level A source.

### As built in v2

- **Concepts:** each kind of business carries its edges as fields. `is_a` gives the `is_a` edges. `licence` gives the licence edge: `{fixed, fee}`, `{bands}` naming a band set in `verdict.bandSets`, or `{cases}`. `docs` gives the `requires_doc` edges, and `sources` default to `defaultSource`, the eligibility table. `lab explain` shows them as `concept:<id>` and `bands:<set>` in the trail.
- **Questions:** each activity has its own "which kind?" question (`service`, `manufacture`, `trade`, `export`) writing its own list. `derive` joins them into `business`: `{from, except}` copies a list, `unsure` becomes the activity itself as a fallback, and import or a marketplace add `importer` or `ecommerce`.
- **Licence per kind of business:** a place rule (`rel: "licence"`, with `applies` by group or concept, inherited through `is_a`) and the concept's own rule, found up the `is_a` chain, are both evaluated. **The higher licence wins, and on a tie the place rule wins** (its fee is specific). A place with an `otherwise` text hands over the kinds it does not cover. The premises verdict is the highest over all kinds of business, and the fee is the highest at that licence.
- **`{needs: key}`** makes a question relevant only when the answer could change the result. The engine re-runs the verdict with the fact at every band boundary and compares licence, fee, outcome and handover.
- **Handover:** a band may be `{handover: text}` (outside the table). With `unknown_kind`, the likely result is still shown with `expert_option`, and when no kind of business is placed the outcome is `handover`.
- **Tasks:** `rel: "task"` edges add the Head Office task (a concept with its own licence and documents) and an "add another premises" offer (§11.4).
- **Walking:** v2's option lists are large, so `lab check` walks every pair of activities, every pair of kinds for a single activity, and single kinds when several activities are picked (`--pick N`). The invariant is "the verdict does not depend on a fact that was never asked".

## 10. Findings that affect the plan

- **The production cache is tiny:** 3 entries (2 for `activity`, 1 for `online`), all from `gemma4-12b-it-mtp`. One is malformed: `kob` is a string, and its `activities` entry has a leading space. So step 2 is mostly about building the converter and sanitiser, not about volume. **Real-user test data has to come from somewhere else as well**, for example phrasings the team writes by hand or landing-chat transcripts.
- `interpretPrompt` asks the LLM for activity buckets, not business kinds. The new `business` concept layer (§2.2) is what gives CLM concrete targets.

## 11. Decisions (reviewed 2026-09-25)

1. **Business layer:** comes in v2. v1 is a pure parity port, so M1 stays a clean regression check.
2. **HANDOVER:** in the lab, offer the expert and let the user continue with taps, and flag the case. This is so tests run every path to the end instead of stopping early. **The live portal may force the expert instead.** So the engine emits `HANDOVER` with a policy flag, `handover: "offer" | "force"`, that the host sets. The lab defaults to `offer`, and the engine's logic is the same either way.
3. **Provisional verdicts:** show the **likely** verdict, with a clear option to have an expert confirm it. The verdict output carries `provisional`, the edges that made it provisional, and an `expert_option`.
4. **Several premises:** each extra premises is **a new licensing task, and the whole loop runs again** for it. At `VERDICT`, when `locations` is `many` or `multistate`, the automaton offers "Add another premises". That starts a new intake seeded only with facts about the business as a whole (the business identity, the activities as a starting point that the user confirms, and the head office link). Facts about each place (`place`, turnover, state) are asked again. A multi-state business also gets a `head_office` task, a separate kind of business on FoSCoS. The engine stays one premises per run; linking the runs is a `group_id` on the tasks.
