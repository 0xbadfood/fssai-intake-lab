#!/usr/bin/env node
// Baseline for the CLM comparison: how well the current approach (a prompted LLM, blind) labels the
// independent test answers (hand-written + production). Exact match of the chosen option set.
// Usage: node loop/baseline.mjs [--out records/eval/baseline.json]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createEngine, loadGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { classify, same, viewMaker } from './classify.mjs'
import { loadEndpoints, makeClient } from './llm.mjs'

const graph = loadGraph(path.join(LAB_ROOT, 'graph/graph.v2.json'))
const E = createEngine(graph)
const makeView = viewMaker(E, graph)
const endpoints = loadEndpoints(path.join(LAB_ROOT, 'loop/endpoints.json'))
const models = { 'qwen3.8-27b (local)': makeClient(endpoints.selfcheck, {}), 'qwen3.8-flash-next (Spark)': makeClient(endpoints.reviewer, {}) }
const load = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

const test = []
for (const dir of ['records/prod', 'records/handwritten']) {
  const root = path.join(LAB_ROOT, dir)
  if (existsSync(root)) for (const f of readdirSync(root, { recursive: true }).filter((x) => String(x).endsWith('.jsonl'))) test.push(...load(path.join(root, f)).map((r) => ({ ...r, origin: dir.split('/')[1] })))
}
const results = {}
for (const [name, client] of Object.entries(models)) {
  const rows = []
  for (const r of test) {
    const view = makeView({ step: r.step, context: r.known_facts || {} })
    const t = Date.now()
    const c = await classify(client, view, r.text).catch((e) => ({ choice: null, error: e.message }))
    rows.push({ id: r.id, origin: r.origin, step: r.step, text: r.text, gold: [...r.targets].sort(), pred: c.choice, ok: !!c.choice && same(c.choice, r.targets), ms: Date.now() - t })
  }
  const acc = (xs) => `${xs.filter((x) => x.ok).length}/${xs.length}`
  results[name] = { accuracy: acc(rows), by_origin: Object.fromEntries(['handwritten', 'prod'].map((o) => [o, acc(rows.filter((x) => x.origin === o))])),
    median_ms: rows.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)], misses: rows.filter((x) => !x.ok).map((x) => `${x.step}: "${x.text}" gold ${x.gold.join('+') || 'none'} → ${x.pred?.join('+') || 'none'}`) }
  console.log(name, results[name].accuracy, 'median', results[name].median_ms, 'ms')
}
mkdirSync(path.join(LAB_ROOT, 'records/eval'), { recursive: true })
writeFileSync(path.join(LAB_ROOT, 'records/eval/baseline.json'), JSON.stringify(results, null, 2))
for (const [n, r] of Object.entries(results)) { console.log(`\n${n} misses:`); r.misses.forEach((m) => console.log('  ', m)) }
