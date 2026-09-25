#!/usr/bin/env node
// Pilot of the cache-fill loop (step 3 / M4), small scale, to measure efficacy before a full run.
//
//   planner   (local 27B)   writes N answers per option of a question, in mixed styles and languages, plus
//                          answers that fit no option; for each it names the option it could be confused with
//   reviewer  (Spark)       classifies every answer BLIND: it sees the question and options, never the intent
//   selfcheck (local 27B)   classifies blind too, in a separate call (a second opinion)
//
// An answer is accepted (status model-reviewed) when the reviewer's choice equals the planner's intent; a no-match
// answer when the reviewer picks nothing. Everything else is kept as a flagged draft. Records go to a staging
// directory only (records/loop/<run>/), never to the portal's cache.
//
// Usage: node loop/pilot.mjs [--steps activity,service,manufacture] [--per 12] [--nomatch 15] [--run NAME]
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createEngine, loadGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { loadEndpoints, makeClient } from './llm.mjs'
import { makeRecord, normalizeText, sha, splitFor } from './records.mjs'
import { report } from './report.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const STEPS = (args.steps || 'activity,service,manufacture').split(',')
const PER = Number(args.per || 12)
const NOMATCH = Number(args.nomatch || 15)
const RUN = args.run || `pilot-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`
const OUT = path.join(LAB_ROOT, 'records/loop', RUN)

const graph = loadGraph(path.join(LAB_ROOT, 'graph/graph.v2.json'))
const E = createEngine(graph)
const endpoints = loadEndpoints(path.join(LAB_ROOT, 'loop/endpoints.json'))
const stats = {}
const planner = makeClient(endpoints.planner, stats)
const selfcheck = makeClient(endpoints.selfcheck, stats)
const reviewer = makeClient(endpoints.reviewer, stats)

// The facts a user has given before reaching each step (so options render as the user would see them).
const CONTEXT = { activity: {}, service: { activities: ['cook'] }, manufacture: { activities: ['make'] }, trade: { activities: ['sell'] } }
// Escape-hatch options the user can tap; a classifier answers "none" instead of picking them.
const ESCAPES = new Set(['unsure', 'none'])

const STYLES = {
  short: '1 to 4 words, the way people answer a chat quickly',
  sentence: 'a plain English sentence',
  hinglish: 'Hindi written in Latin script, as typed on a phone',
  hindi: 'Hindi in Devanagari script',
  typo: 'with spelling mistakes, no capitals or punctuation',
  indirect: 'describe what they actually do without naming the category',
  detailed: 'with extra details: city, products, customers, size or sales',
}
const PROMPT_VERSION = 'loop-v2'

function stepView(stepId) {
  const q = E.QUESTIONS.find((x) => x.id === stepId)
  const facts = E.sanitizeFacts(CONTEXT[stepId] || {})
  const concepts = new Map(graph.concepts.map((c) => [c.id, c]))
  const options = E.optionsFor(q, facts).filter((o) => !ESCAPES.has(o.id)).map((o) => ({ ...o, desc: concepts.get(o.id)?.desc || null }))
  return { q, facts, title: E.titleFor(q, facts), multi: E.isMulti(q, facts), options }
}

const optionList = (options) => options.map((o) => `- ${o.id}: ${o.label} — ${o.example}${o.desc ? ` (${o.desc})` : ''}`).join('\n')

const SYSTEM_PLANNER = 'You write realistic test answers for a chat that helps small Indian food businesses find out which FSSAI registration or licence they need. Answers must sound like real business owners typing on a phone, from all over India. Reply with JSON only.'

async function generate(view, target) {
  const styles = Object.entries(STYLES).map(([k, v]) => `"${k}": ${v}`).join('\n')
  const prompt = `The chat asked the user: "${view.title}"

Options the user could pick:
${optionList(view.options)}

Target option: ${target.id} (${target.label}).
Write ${PER} different answers a user might type that clearly mean "${target.id}" and not any other option.
Use every style below at least once:
${styles}
Rules: vary products, cities, sizes and wording; do not repeat the option label or example words in more than two answers; each answer must be something a real owner would type, not a definition.
For each answer, give the other option id it is most likely to be confused with (null if none).

Reply as JSON: {"answers": [{"text": "...", "style": "short|sentence|hinglish|hindi|typo|indirect|detailed", "lang": "en|hi-Latn|hi|mixed", "confusable_with": "<option id or null>"}]}`
  const r = await planner([{ role: 'system', content: SYSTEM_PLANNER }, { role: 'user', content: prompt }], { temperature: 0.9, maxTokens: 2500 })
  return (r.answers || []).filter((a) => a && typeof a.text === 'string' && a.text.trim())
}

async function generateNoMatch(view) {
  const prompt = `The chat asked the user: "${view.title}"

Options the user could pick:
${optionList(view.options)}

Write ${NOMATCH} answers a user might type to this question that fit NONE of these options. Mix:
- businesses that are not food at all (cosmetics, utensils, pet grooming, tailoring),
- off-topic or unclear replies ("what is fssai", "why do you need this", "ok", a question back),
- food-adjacent activities that none of the options covers (for example growing crops only, a food-testing lab, selling kitchen equipment).
Check every answer against every option above: if any option could reasonably describe it, leave it out. Do not describe cooking, making, packing, selling, storing, transporting, importing or exporting food.
Use a mix of English, Hinglish (Latin script) and Hindi (Devanagari).

Reply as JSON: {"answers": [{"text": "...", "lang": "en|hi-Latn|hi|mixed", "kind": "nonfood|unlisted|offtopic|nearmiss", "why_none": "..."}]}`
  const r = await planner([{ role: 'system', content: SYSTEM_PLANNER }, { role: 'user', content: prompt }], { temperature: 0.9, maxTokens: 2500 })
  return (r.answers || []).filter((a) => a && typeof a.text === 'string' && a.text.trim())
}

function classifyPrompt(view, text) {
  return `A user of an FSSAI licensing chat was asked: "${view.title}"

Options:
${optionList(view.options)}

The user answered: """${text}"""

Which option${view.multi ? '(s)' : ''} does the answer mean? Pick only options the answer clearly states or strongly implies${view.multi ? ' (more than one only if the answer describes more than one)' : ''}. If no option fits, or the answer is off-topic or unclear, return an empty list.
Reply as JSON: {"choice": ["<option id>", ...], "confidence": "high|medium|low"}`
}

async function classify(client, view, text) {
  const ids = new Set(view.options.map((o) => o.id))
  const schema = {
    type: 'object',
    properties: { choice: { type: 'array', items: { type: 'string', enum: [...ids] } }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
    required: ['choice', 'confidence'],
  }
  const r = await client([{ role: 'user', content: classifyPrompt(view, text) }], { temperature: 0, maxTokens: 200, schema })
  const choice = [...new Set((Array.isArray(r.choice) ? r.choice : []).filter((c) => ids.has(c)))]
  return { choice, confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : null }
}

const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x))

async function main() {
  mkdirSync(OUT, { recursive: true })
  const t0 = Date.now()
  const items = []
  for (const stepId of STEPS) {
    const view = stepView(stepId)
    console.error(`[${stepId}] ${view.options.length} options: generating ${PER} per option + ${NOMATCH} no-match`)
    const gens = await Promise.all([
      ...view.options.map(async (o) => (await generate(view, o).catch((e) => (console.error(`  generate ${o.id}: ${e.message}`), []))).map((a) => ({ ...a, target: o.id }))),
      generateNoMatch(view).then((as) => as.map((a) => ({ ...a, target: null, style: a.kind || 'nomatch' }))).catch((e) => (console.error(`  no-match: ${e.message}`), [])),
    ])
    const answers = gens.flat()
    console.error(`[${stepId}] ${answers.length} answers generated; classifying blind (reviewer + selfcheck)`)
    let done = 0
    await Promise.all(answers.map(async (a) => {
      const [rev, self] = await Promise.all([
        classify(reviewer, view, a.text).catch((e) => ({ error: e.message, choice: null })),
        classify(selfcheck, view, a.text).catch((e) => ({ error: e.message, choice: null })),
      ])
      items.push({ step: stepId, view, answer: a, reviewer: rev, selfcheck: self })
      if (++done % 50 === 0) console.error(`  ${done}/${answers.length}`)
    }))
  }

  // Build records. Accepted when the blind reviewer agrees with the planner's intent. Relabelled when both blind
  // classifiers agree, with high confidence, on something other than the intent (the planner mislabelled its own
  // answer); those are accepted under the classifiers' label and marked, so they can be filtered out later.
  const records = []
  const seen = new Set()
  for (const it of items) {
    const { answer: a, view, reviewer: rev, selfcheck: self } = it
    const intent = a.target ? [a.target] : []
    const agree = !!rev.choice && same(rev.choice, intent)
    const relabel = !agree && !!rev.choice?.length && !!self.choice && same(rev.choice, self.choice) && rev.confidence === 'high' && self.confidence === 'high'
    const accepted = agree || relabel
    const label = agree ? intent : relabel ? rev.choice : []
    const strong = agree && self.choice && same(self.choice, intent)
    const candidates = view.options.map((o) => o.id)
    const rec = makeRecord({
      step: it.step, candidates, graphVersion: graph.version, knownFacts: view.facts,
      text: a.text.trim(), lang: a.lang || null,
      targets: label,
      negatives: accepted ? [a.confusable_with, ...(relabel ? intent : [])].filter((x) => x && candidates.includes(x)) : [],
      unknown: accepted && label.length === 0,
      source: 'llm-loop',
      producer: { planner: endpoints.planner.model, reviewer: endpoints.reviewer.model, selfcheck: endpoints.selfcheck.model, prompt: PROMPT_VERSION },
      status: accepted ? 'model-reviewed' : 'draft',
      review: { intent, style: a.style || null, reviewer: rev.choice, reviewer_confidence: rev.confidence ?? null, selfcheck: self.choice, selfcheck_confidence: self.confidence ?? null,
        agree, relabelled: relabel, strong: !!strong, ...(rev.error ? { error: rev.error } : {}), ...(self.error ? { selfcheck_error: self.error } : {}) },
      split: splitFor(normalizeText(a.text)),
    })
    if (seen.has(rec.id)) { rec.review.duplicate = true; rec.status = 'rejected' }
    seen.add(rec.id)
    records.push(rec)
  }

  writeFileSync(path.join(OUT, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const run = {
    run: RUN, started: new Date(t0).toISOString(), seconds: (Date.now() - t0) / 1000, steps: STEPS, per_option: PER, nomatch: NOMATCH,
    graph: { version: graph.version, sha256: sha(JSON.stringify(graph)) }, prompt_version: PROMPT_VERSION,
    endpoints: Object.fromEntries(Object.entries(endpoints).filter(([, v]) => v?.url).map(([k, v]) => [k, { url: v.url, model: v.model }])), usage: stats,
  }
  writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(run, null, 2))
  const md = report(records, run)
  writeFileSync(path.join(OUT, 'REPORT.md'), md)
  console.log(md)
}

await main()
