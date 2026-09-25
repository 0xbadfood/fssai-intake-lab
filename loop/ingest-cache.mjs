#!/usr/bin/env node
// Step 2 (M3): convert the portal's production answer cache (intake_answer_cache) into interpretation records.
//
// Reads the cache READ-ONLY through the portal's own DB module. For each cached typed answer:
//   - maps the portal's (graph v1) question and option ids onto graph v2 (same ids for the steps that exist in both),
//   - cleans the cached facts with the v2 sanitiser (drops malformed values such as `kob` given as a string),
//   - re-checks the cached choice with a blind classification by the reviewer model (Spark),
//   - flags personal details (phone numbers, emails, Aadhaar/PAN-like ids),
//   - puts every record in the `test` split: real user text is for evaluation, never for training.
// Output: records/prod/<date>/records.jsonl + REPORT.md.
//
// Usage: node loop/ingest-cache.mjs [--portal ../fssai-portal] [--out records/prod/2026-09-25]
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createEngine, loadGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { classify, same, viewMaker } from './classify.mjs'
import { loadEndpoints, makeClient } from './llm.mjs'
import { makeRecord } from './records.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const PORTAL = path.resolve(LAB_ROOT, args.portal || '../fssai-portal')
const OUT = path.resolve(LAB_ROOT, args.out || `records/prod/${new Date().toISOString().slice(0, 10)}`)

const graph = loadGraph(path.join(LAB_ROOT, 'graph/graph.v2.json'))
const E = createEngine(graph)
const makeView = viewMaker(E, graph)
const endpoints = loadEndpoints(path.join(LAB_ROOT, 'loop/endpoints.json'))
const reviewer = makeClient(endpoints.reviewer, {})

// Portal (v1) question id -> v2 step. The v1 `trade` ids (retail/wholesale/storage/transport) exist in v2 too.
const STEP = { activity: 'activity', trade: 'trade', place: 'place', vending: 'vending', locations: 'locations', online: 'online', turnover: 'turnover', nonfood: 'nonfood' }
const PII = [
  [/\b[6-9]\d{9}\b/, 'phone'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'email'],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/, 'aadhaar-like'],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/i, 'pan-like'],
]

async function main() {
  const { pool } = await import(`${PORTAL}/server/db.js`)
  let rows
  try {
    // Read-only: a plain SELECT; nothing in the portal is written.
    ;({ rows } = await pool.query('SELECT question_id, options_sig, text_norm, result, model, hits, created_at, last_hit_at FROM intake_answer_cache ORDER BY created_at'))
  } finally {
    await pool.end()
  }
  console.error(`${rows.length} cached answers`)

  const records = []
  const notes = []
  for (const row of rows) {
    const step = STEP[row.question_id]
    if (!step) { notes.push(`skipped question "${row.question_id}" (no v2 step)`); continue }
    const v1Options = String(row.options_sig).split(':').slice(1).join(':').split('|')[0].split(',').filter(Boolean)
    // Context: the facts the model inferred, cleaned by the v2 sanitiser, stand in for what the user had told the chat.
    const cachedFacts = E.sanitizeFacts(row.result?.facts || {})
    const context = Object.fromEntries(Object.entries(cachedFacts).filter(([k]) => ['activities', 'service_kinds', 'make_kinds', 'trade_kinds'].includes(k)))
    const view = makeView({ name: `prod:${step}`, step, context: step === 'activity' ? {} : context })
    const candidates = view.options.map((o) => o.id)
    const cachedChoice = (row.result?.choice || []).filter((c) => candidates.includes(c)).sort()
    const blind = await classify(reviewer, view, row.text_norm).catch((e) => ({ choice: null, error: e.message }))
    const agree = !!blind.choice && same(blind.choice, cachedChoice)
    const pii = PII.filter(([re]) => re.test(row.text_norm)).map(([, k]) => k)
    records.push(makeRecord({
      step, candidates, graphVersion: graph.version, knownFacts: view.facts,
      text: row.text_norm, lang: /[ऀ-ॿ]/.test(row.text_norm) ? 'hi' : null,
      targets: cachedChoice, negatives: [], unknown: cachedChoice.length === 0 && agree,
      facts: cachedFacts,
      source: 'prod-cache',
      producer: { model: row.model, reviewer: endpoints.reviewer.model, portal_graph_version: 1, v1_options: v1Options },
      status: agree ? 'model-reviewed' : 'draft',
      review: { cached_choice: cachedChoice, reviewer: blind.choice, reviewer_confidence: blind.confidence ?? null, agree, hits: row.hits,
        cached_raw_facts: row.result?.facts ?? null, ...(blind.error ? { error: blind.error } : {}) },
      split: 'test',
    }))
    records.at(-1).pii = pii.length > 0
    if (pii.length) records.at(-1).review.pii_kinds = pii
  }

  mkdirSync(OUT, { recursive: true })
  writeFileSync(path.join(OUT, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const L = [`# Production answer cache → records (${new Date().toISOString().slice(0, 10)})`, '',
    `${rows.length} cached answers read (read-only); ${records.length} records; ${records.filter((r) => r.review.agree).length} confirmed by the blind reviewer; ${records.filter((r) => r.pii).length} with personal details. All in the test split.`, '',
    '| Step | Text | Cached choice | Blind reviewer | Agree | Facts (cleaned) |', '|---|---|---|---|---|---|',
    ...records.map((r) => `| ${r.step} | ${r.text} | ${r.review.cached_choice.join('+') || '—'} | ${r.review.reviewer?.join('+') || '—'} | ${r.review.agree ? 'yes' : 'no'} | \`${JSON.stringify(r.facts)}\` |`),
    '', ...notes.map((n) => `- ${n}`)]
  writeFileSync(path.join(OUT, 'REPORT.md'), L.join('\n') + '\n')
  console.log(L.join('\n'))
}

await main()
