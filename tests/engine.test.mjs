import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createEngine, loadGraph, validateGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { makeEvaluator } from '../engine/conditions.js'
import { renderText } from '../engine/text.js'
import { portalAdapter, walkAll } from '../cli/walk.js'

const GRAPH = path.join(LAB_ROOT, 'graph/graph.v1.json')
const PORTAL = path.resolve(LAB_ROOT, '../fssai-portal')
const fresh = () => loadGraph(GRAPH)

test('conditions', () => {
  const ev = makeEvaluator({ defs: { food: { nonempty: 'activities' } }, edges: [{ rel: 'implies', key: 'locations', when: { eq: ['place', 'home'] } }] })
  const f = { activities: ['cook'], trade: [], place: 'home', turnover_crore: 2 }
  assert.equal(ev(true, f), true)
  assert.equal(ev({}, f), true)
  assert.equal(ev({ ref: 'food' }, f), true)
  assert.equal(ev({ only: ['activities', ['cook', 'sell']] }, f), true)
  assert.equal(ev({ only: ['missing', ['x']] }, f), true, 'an empty or missing list passes `only`')
  assert.equal(ev({ empty: 'trade' }, f), true)
  assert.equal(ev({ gt: ['turnover_crore', 1.5] }, f), true)
  assert.equal(ev({ gt: ['missing', 1.5] }, f), false, 'comparisons with a missing number are false')
  assert.equal(ev({ eq: [{ len: 'activities' }, 1] }, f), true)
  assert.equal(ev({ implied: 'locations' }, f), true)
  assert.throws(() => ev({ bogus: 1 }, f), /unknown condition operator/)
})

test('text templates', () => {
  const ev = makeEvaluator({ defs: {}, edges: [] })
  const t = { prefix: 'A ', join: 'or', empty: 'business premises', parts: [
    { when: { has: ['a', 'x'] }, text: 'restaurant' }, { when: { has: ['a', 'y'] }, text: 'factory' }, { when: { has: ['a', 'z'] }, text: 'shop' },
  ] }
  assert.equal(renderText(t, { a: ['x', 'y', 'z'] }, ev), 'A restaurant, factory or shop')
  assert.equal(renderText(t, { a: ['y'] }, ev), 'A factory')
  assert.equal(renderText(t, { a: [] }, ev), 'A business premises')
  assert.equal(renderText({ parts: [{ text: 'home bakery' }], join: '; ', capitalize: true }, {}, ev), 'Home bakery')
  assert.equal(renderText({ cases: [{ when: { known: 'k' }, text: 'x' }] }, {}, ev), null)
})

test('graph v1 validates (schema, references, source quotes)', () => {
  assert.deepEqual(validateGraph(fresh()), [])
})

test('validator catches broken graphs', () => {
  const g = fresh()
  g.facts[0].relevant = { ref: 'nope' }
  g.edges.push({ id: 'x', rel: 'forces', status: 'expert', to: 'central', when: { eq: ['no_such_key', 1] }, sources: [{ level: 'B', file: 'sources/KindofBusinessEligibility-2026-04-02.txt', page: 1, quote: 'not on this page at all' }] })
  const problems = validateGraph(g).join('\n')
  assert.match(problems, /unknown ref "nope"/)
  assert.match(problems, /unknown key "no_such_key"/)
  assert.match(problems, /expert status needs a level A source/)
  assert.match(problems, /quote not found/)
})

test('verdict trail and provisional flag', () => {
  const E = createEngine(fresh())
  const v = E.verdict(E.sanitizeFacts({ activities: ['import'], place: 'premises', locations: 'one', states: ['Goa'] }))
  assert.equal(v.licence, 'Central Licence')
  assert.deepEqual(v.trail, ['central-importer'])
  assert.equal(v.provisional, true, 'v1 edges are all draft')
  assert.equal(v.expert_option, true)
})

test('every path: invariants hold and verdict counts match the portal baseline', () => {
  const E = createEngine(fresh())
  const r = walkAll(E, E)
  assert.deepEqual(r.failures, [])
  assert.equal(r.paths, 17574)
  assert.deepEqual(r.verdicts, { deemed: 1398, 'FSSAI Registration': 3690, 'State Licence': 3642, 'Central Licence': 8838, notfood: 6 })
})

test('parity with the portal on every path, including sampled typed merges', async () => {
  const portal = await portalAdapter(PORTAL)
  const E = createEngine(fresh())
  const r = walkAll(E, E, { portal, mergeEvery: 7 })
  assert.deepEqual(r.parity, [])
  assert.deepEqual(r.failures, [])
})

// Each mutation changes one thing in the graph; the parity walk must notice it.
const MUTATIONS = {
  'option label': (g) => { g.facts.find((q) => q.id === 'place').values.find((v) => v.id === 'hub').label = 'Airport or railway' },
  'threshold limit': (g) => { g.edges.find((e) => e.id === 'turnover-bands').bands[1].lte = 49 },
  'relevance condition': (g) => { g.facts.find((q) => q.id === 'online').relevant = { ref: 'food' } },
  'unlikely rule': (g) => { g.edges.find((e) => e.id === 'street-high-sales').when.all[1] = { gt: ['turnover_crore', 50] } },
  'keep rule (sanitize)': (g) => { g.keep = g.keep.filter((k) => k.key !== 'municipal_registered') },
  'forced reason text': (g) => { g.verdict.forcedReasons[1] = 'This overrides turnover.' },
  'implied message': (g) => { g.edges.find((e) => e.id === 'home-one-place').fixLabel.cases[1].text = 'One place: home' },
  'option order': (g) => { const q = g.facts.find((x) => x.id === 'locations'); q.values.reverse() },
  'summary text': (g) => { g.facts.find((q) => q.id === 'trade').values[0].show = 'Retail' },
  'note edge': (g) => { g.edges = g.edges.filter((e) => e.id !== 'note-hub-route') },
}

for (const [name, mutate] of Object.entries(MUTATIONS)) {
  test(`parity catches a changed ${name}`, async () => {
    const portal = await portalAdapter(PORTAL)
    const g = fresh()
    mutate(g)
    const E = createEngine(g)
    const r = walkAll(E, E, { portal, mergeEvery: 1, stopOnParity: true })
    assert.ok(r.parity.length > 0, `mutation "${name}" went unnoticed`)
  })
}

// ---------- graph v2 (FoSCoS kinds of business) ----------

import { readFileSync } from 'node:fs'
import { runCases } from '../cli/cases.js'

const GRAPH2 = path.join(LAB_ROOT, 'graph/graph.v2.json')
const fresh2 = () => loadGraph(GRAPH2)

test('graph v2 validates (concepts, is_a, licence rules, bands, documents, source quotes)', () => {
  assert.deepEqual(validateGraph(fresh2()), [])
})

test('validator catches broken v2 concepts', () => {
  const g = fresh2()
  g.concepts.find((c) => c.id === 'general').is_a = ['packaged_water'] // cycle: packaged_water is_a general
  g.concepts.find((c) => c.id === 'oil').licence = { bands: 'no_such_set' }
  g.concepts.find((c) => c.id === 'fish').docs = ['no_such_doc']
  g.concepts.find((c) => c.id === 'meat').sources = [{ page: 2, quote: 'this sentence is not in the table' }]
  delete g.concepts.find((c) => c.id === 'wholesale').licence
  g.concepts.find((c) => c.id === 'wholesale').is_a = []
  const problems = validateGraph(g).join('\n')
  assert.match(problems, /is_a cycle/)
  assert.match(problems, /unknown band set no_such_set/)
  assert.match(problems, /unknown document no_such_doc/)
  assert.match(problems, /quote not found on page 2/)
  assert.match(problems, /wholesale: no licence rule/)
})

test('v2 scenario cases (portal errors corrected against the FoSCoS table)', () => {
  const E = createEngine(fresh2())
  const { cases } = JSON.parse(readFileSync(path.join(LAB_ROOT, 'tests/cases.v2.json'), 'utf8'))
  const failed = runCases(E, cases).filter((r) => r.problems.length).map((r) => `${r.name}: ${r.problems.join('; ')}`)
  assert.deepEqual(failed, [])
})

test('v2 walk (one kind per question): every path ends in a verdict or a handover, invariants hold', () => {
  const E = createEngine(fresh2())
  const r = walkAll(E, E, { maxPick: () => 1 })
  assert.deepEqual(r.failures, [])
  assert.ok(r.paths > 10000, `only ${r.paths} paths`)
  assert.ok(r.verdicts.handover > 0, 'some paths should reach the expert handover')
})

test('a place never lowers a Central-only kind of business', () => {
  const E = createEngine(fresh2())
  const f = E.sanitizeFacts({ activities: ['cook'], service_kinds: ['hotel'], hotel_stars: 'five', place: 'railway', locations: 'one', states: ['Delhi'], turnover_crore: 1.5 })
  assert.equal(E.verdict(f).licence_id, 'central')
})
