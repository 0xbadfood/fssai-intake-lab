#!/usr/bin/env node
// Full cache-fill run (step 3 / M4), driven by a plan file (loop/plan.full.json). Same method as the pilot:
// the planner writes answers, Spark and the local model classify them blind, and a record is kept when the
// reviewer matches the intent (or both classifiers agree, with high confidence, on another option: relabelled).
//
// Resumable: every generation and classification is appended to <run>/gen.jsonl and <run>/cls.jsonl as it
// finishes; a rerun with the same --run skips work already done. Records go to staging only.
//
// Usage: node loop/fill.mjs [--plan loop/plan.full.json] [--run full-1] [--views service,manufacture]
//
// Reclassify mode (after expert decisions): re-run only the blind classification of the saved answers, with
// the labelling rules in loop/guidance.json added to the prompt, and write a complete new record set to
// <run>/<tag>/ plus CHANGES.md (what moved). Generation is not repeated.
//   node loop/fill.mjs --run full-1 --reclassify --guidance loop/guidance.json --tag expert-v1 [--status agreed,changed]
// --status proposed estimates the impact of our proposed resolutions before the expert has answered.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createEngine, loadGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { loadEndpoints, makeClient } from './llm.mjs'
import { makeRecord, normalizeText, sha, splitFor, tokenSignature } from './records.mjs'
import { report } from './report.mjs'
import { classify as classifyShared, optionList, same, viewMaker } from './classify.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const plan = JSON.parse(readFileSync(path.resolve(LAB_ROOT, args.plan || 'loop/plan.full.json'), 'utf8'))
const RUN = args.run || 'full-1'
const OUT = path.join(LAB_ROOT, 'records/loop', RUN)
const ONLY = args.views ? new Set(args.views.split(',')) : null
const RECLASSIFY = 'reclassify' in args
const TAG = args.tag || null
if (RECLASSIFY && !TAG) throw new Error('--reclassify needs --tag NAME')
const STATUSES = new Set((args.status || 'agreed,changed').split(','))
const guidance = args.guidance ? JSON.parse(readFileSync(path.resolve(LAB_ROOT, args.guidance), 'utf8')).rules.filter((r) => STATUSES.has(r.status)) : []
const notesFor = (viewName, step) => guidance.filter((r) => r.views.includes(viewName) || r.views.includes(step)).map((r) => `${r.rule} [${r.decision}]`)
const PROMPT_VERSION = RECLASSIFY ? `fill-v1+guidance:${TAG}` : 'fill-v1'

const graph = loadGraph(path.resolve(LAB_ROOT, plan.graph))
const E = createEngine(graph)
const endpoints = loadEndpoints(path.join(LAB_ROOT, 'loop/endpoints.json'))
const stats = {}
const planner = makeClient(endpoints.planner, stats)
const selfcheck = makeClient(endpoints.selfcheck, stats)
const reviewer = makeClient(endpoints.reviewer, stats)

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
const CLS = path.join(OUT, RECLASSIFY ? `cls.${TAG}.jsonl` : 'cls.jsonl')
const RECORDS_DIR = RECLASSIFY ? path.join(OUT, TAG) : OUT
const gens = new Map(load(GEN).map((g) => [g.key, g]))
const clss = new Map(load(CLS).map((c) => [c.key, c]))

// ---------- views ----------
const makeView = viewMaker(E, graph)
const contextLine = (view) => view.context

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

// ---------- blind classification (shared prompt: loop/classify.mjs) ----------
const classify = (client, view, text) => classifyShared(client, view, text, notesFor(view.name, view.step))

/** What moved between two record sets for the same answers (matched by record id). */
function changes(before, after) {
  const byId = new Map(before.map((r) => [r.id, r]))
  const label = (r) => (r.status === 'model-reviewed' ? (r.targets.length ? r.targets.join('+') : 'none') : 'dropped')
  const moved = []
  for (const r of after) {
    const b = byId.get(r.id)
    if (b && label(b) !== label(r)) moved.push({ view: r.review.view, from: label(b), to: label(r), text: r.text })
  }
  const L = [`# Changes from the labelling rules (${TAG})`, '', `${moved.length} of ${after.length} answers changed label.`, '']
  const counts = moved.reduce((m, x) => ((m[`${x.view}: ${x.from} → ${x.to}`] = (m[`${x.view}: ${x.from} → ${x.to}`] || 0) + 1), m), {})
  L.push('| Change | Answers |', '|---|---:|', ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `| ${k} | ${n} |`), '')
  L.push('Examples (up to 3 per change):', '')
  for (const k of Object.keys(counts)) for (const x of moved.filter((m) => `${m.view}: ${m.from} → ${m.to}` === k).slice(0, 3)) L.push(`- ${k} · "${x.text}"`)
  return L.join('\n') + '\n'
}
const log = (...m) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...m)

async function main() {
  const t0 = Date.now()
  const allViews = plan.views.map(makeView)
  // Reclassify touches only the views that have a labelling rule (or --views); the rest are copied unchanged.
  const views = allViews.filter((v) => (ONLY ? ONLY.has(v.name) : RECLASSIFY ? notesFor(v.name, v.step).length > 0 : true))
  if (RECLASSIFY) log(`reclassifying ${views.map((v) => v.name).join(', ')} with ${guidance.length} rule(s) (status: ${[...STATUSES].join(', ')})`)

  // 1. Generation tasks (skip the ones already on disk).
  const tasks = []
  for (const v of views) {
    for (const o of v.options) for (let r = 0; r < plan.rounds; r++) tasks.push({ key: `${v.name}|${o.id}|r${r}`, view: v, intent: [o.id], round: r })
    for (const c of v.combos || []) if (c.every((id) => v.options.some((o) => o.id === id))) tasks.push({ key: `${v.name}|${[...c].sort().join('+')}|combo`, view: v, intent: [...c].sort(), round: 1 })
    const half = Math.ceil(plan.nomatch / 2)
    for (let r = 0; r < 2; r++) tasks.push({ key: `${v.name}|none|r${r}`, view: v, intent: [], round: r, nomatch: half })
  }
  const todo = RECLASSIFY ? [] : tasks.filter((t) => !gens.has(t.key))
  if (RECLASSIFY && tasks.some((t) => !gens.has(t.key))) throw new Error('reclassify needs the full generation log (gen.jsonl) of this run')
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
  mkdirSync(RECORDS_DIR, { recursive: true })
  if (RECLASSIFY) {
    const base = load(path.join(OUT, 'records.jsonl'))
    const touched = new Set(views.map((v) => v.name))
    const untouched = base.filter((r) => !touched.has(r.review.view))
    writeFileSync(path.join(RECORDS_DIR, 'CHANGES.md'), changes(base.filter((r) => touched.has(r.review.view)), records))
    records.push(...untouched)
  }
  writeFileSync(path.join(RECORDS_DIR, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const run = {
    run: RUN, finished: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, steps: views.map((v) => v.name),
    per_option: plan.per * plan.rounds, nomatch: plan.nomatch, duplicates_dropped: dupes,
    graph: { version: graph.version, sha256: sha(JSON.stringify(graph)) }, prompt_version: PROMPT_VERSION, plan,
    endpoints: Object.fromEntries(Object.entries(endpoints).filter(([, v]) => v?.url).map(([k, v]) => [k, { url: v.url, model: v.model }])), usage: stats,
  }
  if (RECLASSIFY) run.guidance = guidance
  writeFileSync(path.join(RECORDS_DIR, 'run.json'), JSON.stringify(run, null, 2))
  writeFileSync(path.join(RECORDS_DIR, 'REPORT.md'), report(records, run))
  log(`done: ${records.filter((r) => r.status === 'model-reviewed').length} records kept of ${records.length}`)
}

await main()
