#!/usr/bin/env node
// Full cache-fill run (step 3 / M4), driven by a plan file (loop/plan.full.json). Same method as the pilot:
// the planner writes answers, Spark and the local model classify them blind, and a record is kept when the
// reviewer matches the intent (or both classifiers agree, with high confidence, on another option: relabelled).
//
// Resumable: every generation and classification is appended to <run>/gen.jsonl and <run>/cls.jsonl as it
// finishes; a rerun with the same --run skips work already done. Records go to staging only.
//
// Usage: node loop/fill.mjs [--plan loop/plan.full.json] [--run full-1] [--views service,manufacture]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createEngine, loadGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { loadEndpoints, makeClient } from './llm.mjs'
import { makeRecord, normalizeText, sha, splitFor, tokenSignature } from './records.mjs'
import { report } from './report.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const plan = JSON.parse(readFileSync(path.resolve(LAB_ROOT, args.plan || 'loop/plan.full.json'), 'utf8'))
const RUN = args.run || 'full-1'
const OUT = path.join(LAB_ROOT, 'records/loop', RUN)
const ONLY = args.views ? new Set(args.views.split(',')) : null
const PROMPT_VERSION = 'fill-v1'

const graph = loadGraph(path.resolve(LAB_ROOT, plan.graph))
const E = createEngine(graph)
const endpoints = loadEndpoints(path.join(LAB_ROOT, 'loop/endpoints.json'))
const stats = {}
const planner = makeClient(endpoints.planner, stats)
const selfcheck = makeClient(endpoints.selfcheck, stats)
const reviewer = makeClient(endpoints.reviewer, stats)
const ESCAPES = new Set(['unsure', 'none'])
const concepts = new Map((graph.concepts || []).map((c) => [c.id, c]))

const STYLES = {
  short: '1 to 4 words, the way people answer a chat quickly',
  sentence: 'a plain English sentence',
  hinglish: 'Hindi written in Latin script, as typed on a phone',
  hindi: 'Hindi in Devanagari script',
  typo: 'with spelling mistakes, no capitals or punctuation',
  indirect: 'describe what they actually do without naming the category',
  detailed: 'with extra details: city, products, customers, size or sales',
}
const SYSTEM = 'You write realistic test answers for a chat that helps small Indian food businesses find out which FSSAI registration or licence they need. Answers must sound like real business owners typing on a phone. Reply with JSON only.'

// ---------- resumable state ----------
mkdirSync(OUT, { recursive: true })
const load = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const GEN = path.join(OUT, 'gen.jsonl')
const CLS = path.join(OUT, 'cls.jsonl')
const gens = new Map(load(GEN).map((g) => [g.key, g]))
const clss = new Map(load(CLS).map((c) => [c.key, c]))

// ---------- views ----------
function makeView(v) {
  const q = E.QUESTIONS.find((x) => x.id === v.step)
  const facts = E.sanitizeFacts(v.context || {})
  const options = E.optionsFor(q, facts).filter((o) => !ESCAPES.has(o.id)).map((o) => ({ ...o, desc: concepts.get(o.id)?.desc || null }))
  return { ...v, q, facts, title: E.titleFor(q, facts), multi: E.isMulti(q, facts), options }
}
const optionList = (options) => options.map((o) => `- ${o.id}: ${o.label} — ${o.example}${o.desc ? ` (${o.desc})` : ''}`).join('\n')
const contextLine = (view) => {
  const rows = E.summary(view.facts).map((r) => r.value).filter(Boolean)
  return rows.length ? `What the user already told the chat: ${rows.join('; ')}.\n` : ''
}

// ---------- generation ----------
async function generate(view, targetIds, round) {
  const persona = plan.personas[round % plan.personas.length]
  const labels = targetIds.map((id) => view.options.find((o) => o.id === id)).map((o) => `"${o.id}" (${o.label})`)
  const combo = targetIds.length > 1
  const n = combo ? plan.combo_per : plan.per
  const prompt = `${contextLine(view)}The chat asked the user: "${view.title}"

Options the user could pick${view.multi ? ' (more than one allowed)' : ''}:
${optionList(view.options)}

${combo ? `Write ${n} different answers that clearly mean BOTH ${labels.join(' and ')} — a business that does both — and no other option.` : `Target option: ${labels[0]}. Write ${n} different answers a user might type that clearly mean this option and not any other option.`}
Write them as ${persona}.
Use every style below at least once:
${Object.entries(STYLES).map(([k, v]) => `"${k}": ${v}`).join('\n')}
Rules: vary products, places, sizes and wording; do not repeat the option label or example words in more than two answers; each answer must be something a real owner would type, not a definition.
For each answer, give the other option id it is most likely to be confused with (null if none).

Reply as JSON: {"answers": [{"text": "...", "style": "short|sentence|hinglish|hindi|typo|indirect|detailed", "lang": "en|hi-Latn|hi|mixed", "confusable_with": "<option id or null>"}]}`
  const r = await planner([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { temperature: 0.9, maxTokens: 3000 })
  return (r.answers || []).filter((a) => a && typeof a.text === 'string' && a.text.trim())
}

async function generateNoMatch(view, round, n) {
  const persona = plan.personas[round % plan.personas.length]
  const prompt = `${contextLine(view)}The chat asked the user: "${view.title}"

Options the user could pick:
${optionList(view.options)}

Write ${n} answers a user might type to this question that fit NONE of these options, as ${persona}. Mix:
- businesses that are not food at all (cosmetics, utensils, pet grooming, tailoring),
- off-topic or unclear replies ("what is fssai", "why do you need this", "ok", a question back),
- replies that are about food but answer none of the options (for example growing crops only, a food-testing lab, selling kitchen equipment).
Check every answer against every option above: if any option could reasonably describe it, leave it out.
Use a mix of English, Hinglish (Latin script) and Hindi (Devanagari).

Reply as JSON: {"answers": [{"text": "...", "lang": "en|hi-Latn|hi|mixed", "kind": "nonfood|unlisted|offtopic", "why_none": "..."}]}`
  const r = await planner([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], { temperature: 0.9, maxTokens: 3000 })
  return (r.answers || []).filter((a) => a && typeof a.text === 'string' && a.text.trim())
}

// ---------- blind classification ----------
function classifyPrompt(view, text) {
  return `${contextLine(view)}A user of an FSSAI licensing chat was asked: "${view.title}"

Options:
${optionList(view.options)}

The user answered: """${text}"""

Which option${view.multi ? '(s)' : ''} does the answer mean? Pick only options the answer clearly states or strongly implies${view.multi ? ' (more than one only if the answer describes more than one)' : ''}. If no option fits, or the answer is off-topic or unclear, return an empty list.
Reply as JSON: {"choice": ["<option id>", ...], "confidence": "high|medium|low"}`
}
async function classify(client, view, text) {
  const ids = view.options.map((o) => o.id)
  const schema = {
    type: 'object',
    properties: { choice: { type: 'array', items: { type: 'string', enum: ids } }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
    required: ['choice', 'confidence'],
  }
  const r = await client([{ role: 'user', content: classifyPrompt(view, text) }], { temperature: 0, maxTokens: 200, schema })
  return { choice: [...new Set((r.choice || []).filter((c) => ids.includes(c)))].sort(), confidence: r.confidence ?? null }
}

const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x))
const log = (...m) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...m)

async function main() {
  const t0 = Date.now()
  const views = plan.views.filter((v) => !ONLY || ONLY.has(v.name)).map(makeView)

  // 1. Generation tasks (skip the ones already on disk).
  const tasks = []
  for (const v of views) {
    for (const o of v.options) for (let r = 0; r < plan.rounds; r++) tasks.push({ key: `${v.name}|${o.id}|r${r}`, view: v, intent: [o.id], round: r })
    for (const c of v.combos || []) if (c.every((id) => v.options.some((o) => o.id === id))) tasks.push({ key: `${v.name}|${[...c].sort().join('+')}|combo`, view: v, intent: [...c].sort(), round: 1 })
    const half = Math.ceil(plan.nomatch / 2)
    for (let r = 0; r < 2; r++) tasks.push({ key: `${v.name}|none|r${r}`, view: v, intent: [], round: r, nomatch: half })
  }
  const todo = tasks.filter((t) => !gens.has(t.key))
  log(`${views.length} views, ${tasks.length} generation tasks (${todo.length} to do)`)
  let g = 0
  await Promise.all(todo.map(async (t) => {
    try {
      const answers = t.nomatch ? await generateNoMatch(t.view, t.round, t.nomatch) : await generate(t.view, t.intent, t.round)
      const rec = { key: t.key, view: t.view.name, intent: t.intent, round: t.round, answers: answers.map((a) => ({ ...a, style: t.nomatch ? a.kind || 'nomatch' : a.style })) }
      appendFileSync(GEN, JSON.stringify(rec) + '\n')
      gens.set(t.key, rec)
    } catch (e) {
      log(`generate ${t.key}: ${e.message}`)
    }
    if (++g % 25 === 0) log(`  generated ${g}/${todo.length}`)
  }))

  // 2. Answers: de-duplicate within a view by token signature (same words in any order).
  const byView = new Map(views.map((v) => [v.name, v]))
  const answers = []
  const sigs = new Set()
  let dupes = 0
  for (const t of tasks) {
    const rec = gens.get(t.key)
    if (!rec) continue
    for (const a of rec.answers) {
      const sig = `${rec.view}|${tokenSignature(a.text) || normalizeText(a.text)}`
      if (sigs.has(sig)) { dupes++; continue }
      sigs.add(sig)
      answers.push({ view: byView.get(rec.view), intent: rec.intent, round: rec.round, answer: a, key: `${rec.view}|${normalizeText(a.text)}` })
    }
  }
  log(`${answers.length} distinct answers (${dupes} duplicates dropped); classifying blind`)

  // 3. Blind classification (skip what is on disk).
  let c = 0
  const pending = answers.filter((x) => !clss.has(x.key))
  await Promise.all(pending.map(async (x) => {
    const [rev, self] = await Promise.all([
      classify(reviewer, x.view, x.answer.text).catch((e) => ({ error: e.message, choice: null })),
      classify(selfcheck, x.view, x.answer.text).catch((e) => ({ error: e.message, choice: null })),
    ])
    const rec = { key: x.key, reviewer: rev, selfcheck: self }
    if (!rev.error && !self.error) appendFileSync(CLS, JSON.stringify(rec) + '\n')
    clss.set(x.key, rec)
    if (++c % 100 === 0) log(`  classified ${c}/${pending.length}`)
  }))

  // 4. Records.
  const records = []
  for (const x of answers) {
    const cl = clss.get(x.key) || { reviewer: { choice: null, error: 'missing' }, selfcheck: { choice: null } }
    const rev = cl.reviewer
    const self = cl.selfcheck
    const intent = x.intent
    const agree = !!rev.choice && same(rev.choice, intent)
    const relabel = !agree && !!rev.choice?.length && !!self.choice && same(rev.choice, self.choice) && rev.confidence === 'high' && self.confidence === 'high'
    const accepted = agree || relabel
    const label = agree ? intent : relabel ? rev.choice : []
    const candidates = x.view.options.map((o) => o.id)
    records.push(makeRecord({
      step: x.view.step, candidates, graphVersion: graph.version, knownFacts: x.view.facts,
      text: x.answer.text.trim(), lang: x.answer.lang || null,
      targets: label,
      negatives: accepted ? [x.answer.confusable_with, ...(relabel ? intent : [])].filter((n) => n && candidates.includes(n)) : [],
      unknown: accepted && label.length === 0,
      source: 'llm-loop',
      producer: { planner: endpoints.planner.model, reviewer: endpoints.reviewer.model, selfcheck: endpoints.selfcheck.model, prompt: PROMPT_VERSION },
      status: accepted ? 'model-reviewed' : 'draft',
      review: { view: x.view.name, round: x.round, intent, style: x.answer.style || null, reviewer: rev.choice, reviewer_confidence: rev.confidence ?? null,
        selfcheck: self.choice, selfcheck_confidence: self.confidence ?? null, agree, relabelled: relabel,
        strong: agree && !!self.choice && same(self.choice, intent), ...(rev.error ? { error: rev.error } : {}) },
      split: splitFor(normalizeText(x.answer.text)),
    }))
  }
  writeFileSync(path.join(OUT, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const run = {
    run: RUN, finished: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, steps: views.map((v) => v.name),
    per_option: plan.per * plan.rounds, nomatch: plan.nomatch, duplicates_dropped: dupes,
    graph: { version: graph.version, sha256: sha(JSON.stringify(graph)) }, prompt_version: PROMPT_VERSION, plan,
    endpoints: Object.fromEntries(Object.entries(endpoints).filter(([, v]) => v?.url).map(([k, v]) => [k, { url: v.url, model: v.model }])), usage: stats,
  }
  writeFileSync(path.join(OUT, 'run.json'), JSON.stringify(run, null, 2))
  writeFileSync(path.join(OUT, 'REPORT.md'), report(records, run))
  log(`done: ${records.filter((r) => r.status === 'model-reviewed').length} records kept of ${records.length}`)
}

await main()
