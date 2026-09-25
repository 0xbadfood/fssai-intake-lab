#!/usr/bin/env node
// Build a CLM "choice" dataset (typed decisions) from interpretation records.
//
// One row per record: the state is what the user already told the chat plus their typed answer, the question
// is the chat's question, and the candidates are the options (label — example (description)) plus an explicit
// "none" option, so the model can say that nothing fits. Multi-option answers get soft probabilities.
//
// Splits: train = generated records (split train, model-reviewed); test = generated dev split, the production
// cache records, and any hand-written sets (records/handwritten/*.jsonl). Each test row keeps its origin so
// results can be reported per source.
//
// Usage: node loop/clm-data.mjs --records records/loop/full-1/records.jsonl [--out ../clm/data/fssai]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createEngine, loadGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { viewMaker } from './classify.mjs'
import { NONE_KEY, clmRequest } from './clm-format.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []))
const RECORDS = path.resolve(LAB_ROOT, args.records || 'records/loop/full-1/records.jsonl')
const OUT = path.resolve(LAB_ROOT, args.out || '../clm/data/fssai')

const graph = loadGraph(path.join(LAB_ROOT, 'graph/graph.v2.json'))
const E = createEngine(graph)
const makeView = viewMaker(E, graph)
const load = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

function row(r, origin) {
  const view = makeView({ step: r.step, context: r.known_facts || {} })
  const shown = { ...view, options: view.options.filter((o) => r.candidates.includes(o.id)) }
  const { state, questions } = clmRequest(E, shown, r.text)
  const criteria = questions.q.criteria
  const targets = r.targets.length ? r.targets.filter((t) => t in criteria) : [NONE_KEY]
  if (!targets.length) return null
  return {
    id: r.id,
    workflow: r.step,
    origin,
    state: JSON.stringify(state),
    questions: JSON.stringify(questions),
    gold: JSON.stringify({ q: { label: targets[0], probabilities: Object.fromEntries(targets.map((t) => [t, 1 / targets.length])) } }),
    lang: r.lang || null,
    multi: targets.length > 1,
  }
}

const generated = load(RECORDS).filter((r) => r.status === 'model-reviewed')
const train = generated.filter((r) => r.split === 'train').map((r) => row(r, 'generated')).filter(Boolean)
const test = generated.filter((r) => r.split === 'dev').map((r) => row(r, 'generated-dev')).filter(Boolean)
for (const dir of ['records/prod', 'records/handwritten']) {
  const root = path.join(LAB_ROOT, dir)
  if (!existsSync(root)) continue
  for (const f of readdirSync(root, { recursive: true }).filter((x) => String(x).endsWith('.jsonl'))) {
    for (const r of load(path.join(root, f))) if (r.status === 'model-reviewed' || r.source === 'human') test.push(row(r, dir.split('/')[1]))
  }
}

mkdirSync(path.join(OUT, 'all'), { recursive: true })
writeFileSync(path.join(OUT, 'all', 'train.jsonl'), train.map((x) => JSON.stringify(x)).join('\n') + '\n')
writeFileSync(path.join(OUT, 'all', 'test.jsonl'), test.filter(Boolean).map((x) => JSON.stringify(x)).join('\n') + '\n')
const by = (xs, k) => xs.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {})
console.log(JSON.stringify({ out: OUT, train: train.length, test: test.length, test_by_origin: by(test.filter(Boolean), 'origin'), train_by_step: by(train, 'workflow'), multi_in_train: train.filter((x) => x.multi).length }, null, 1))
