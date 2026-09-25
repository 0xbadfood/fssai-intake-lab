// Load and validate a graph file (DESIGN.md §2.5, static invariants). Path-level invariants are checked by
// walking every path (cli/walk.js); this file checks what can be seen without walking.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { lintCondition } from './conditions.js'
import { templateConditions } from './text.js'

export const LAB_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const RELS = ['implies', 'unlikely', 'outcome', 'reason', 'forces', 'threshold', 'note', 'requires_doc', 'is_a', 'sets', 'needs', 'licence', 'task']
const STATUSES = ['draft', 'model-reviewed', 'expert', 'rejected']

export function loadGraph(file) {
  const graph = JSON.parse(readFileSync(file, 'utf8'))
  graph.__file = file
  return graph
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

export function validateGraph(graph) {
  const problems = []
  const keys = new Set([...graph.keys.map((k) => k.id), ...(graph.derive || []).map((d) => d.key)])
  const defs = graph.defs || {}
  const conceptIds = new Set((graph.concepts || []).map((c) => c.id))
  const ctx = { defs, keys, concepts: conceptIds }
  const lint = (c, where) => lintCondition(c, ctx, where, problems)
  const lintText = (t, where) => templateConditions(t).forEach((c, i) => lint(c, `${where}~${i}`))

  // defs: resolvable and acyclic
  for (const [name, c] of Object.entries(defs)) lint(c, `defs.${name}`)
  const refsOf = (c, out = []) => {
    if (!c || typeof c !== 'object') return out
    if (c.ref) out.push(c.ref)
    for (const v of Object.values(c)) if (v && typeof v === 'object') Array.isArray(v) ? v.forEach((x) => refsOf(x, out)) : refsOf(v, out)
    return out
  }
  const visiting = new Set()
  const visited = new Set()
  const visit = (n, trail) => {
    if (visited.has(n)) return
    if (visiting.has(n)) return problems.push(`defs: cycle ${[...trail, n].join(' → ')}`)
    visiting.add(n)
    for (const r of refsOf(defs[n])) if (r in defs) visit(r, [...trail, n])
    visiting.delete(n)
    visited.add(n)
  }
  Object.keys(defs).forEach((n) => visit(n, []))

  for (const k of graph.keep || []) { if (!keys.has(k.key)) problems.push(`keep: unknown key ${k.key}`); lint(k.when, `keep.${k.key}`) }
  for (const d of graph.derive || []) {
    lint(d.when, `derive.${d.key}`)
    if (d.bool) lint(d.bool, `derive.${d.key}.bool`)
    for (const [i, x] of (d.list || []).entries()) lint(x.when, `derive.${d.key}.list[${i}]`)
  }

  // concepts (graph v2): kinds of business with is_a, licence rules, documents and sources
  const src = (s) => ({ ...(graph.defaultSource || {}), ...s })
  const V = graph.verdict || {}
  const groups = new Set((graph.concepts || []).map((c) => c.group).filter(Boolean))
  const docIds = new Set(Object.keys(V.documents?.catalogue || {}))
  function checkRule(rule, where) {
    if (!rule) return
    if (rule.cases) return rule.cases.forEach((c, i) => { lint(c.when, `${where}.cases[${i}]`); checkRule(c, `${where}.cases[${i}]`) })
    if (rule.fixed && !(rule.fixed in V.licences)) problems.push(`${where}: unknown licence ${rule.fixed}`)
    if (rule.bands && !(rule.bands in (V.bandSets || {}))) problems.push(`${where}: unknown band set ${rule.bands}`)
    if (!rule.fixed && !rule.bands) problems.push(`${where}: needs fixed, bands or cases`)
  }
  if (graph.concepts) {
    const seen = new Set()
    for (const c of graph.concepts) {
      const w = `concepts.${c.id}`
      if (!c.id || seen.has(c.id)) problems.push(`${w}: missing or duplicate id`)
      seen.add(c.id)
      for (const p of c.is_a || []) if (!conceptIds.has(p)) problems.push(`${w}: is_a unknown concept ${p}`)
      checkRule(c.licence, `${w}.licence`)
      for (const d of c.docs || []) if (!docIds.has(d)) problems.push(`${w}: unknown document ${d}`)
      if (c.status && !STATUSES.includes(c.status)) problems.push(`${w}: bad status ${c.status}`)
      for (const [i, s] of (c.sources || []).entries()) checkSource(src(s), `${w}.sources[${i}]`, problems)
      if (c.kind !== 'activity' && c.group !== 'special' && !(c.is_a || []).length) problems.push(`${w}: a kind of business needs an is_a link to its activity`)
    }
    // is_a must be acyclic, and every kind of business must reach a licence rule
    const byId = new Map(graph.concepts.map((c) => [c.id, c]))
    const state = new Map()
    const dfs = (id, path) => {
      if (state.get(id) === 2) return
      if (state.get(id) === 1) return problems.push(`is_a cycle: ${[...path, id].join(' → ')}`)
      state.set(id, 1)
      for (const p of byId.get(id)?.is_a || []) dfs(p, [...path, id])
      state.set(id, 2)
    }
    graph.concepts.forEach((c) => dfs(c.id, []))
    const reaches = (id, seen = new Set()) => !!byId.get(id)?.licence || (byId.get(id)?.is_a || []).some((p) => !seen.has(p) && reaches(p, new Set([...seen, id])))
    for (const c of graph.concepts) if (c.kind !== 'activity' && !reaches(c.id)) problems.push(`concepts.${c.id}: no licence rule on it or any concept it is_a`)
  }
  for (const [name, set] of Object.entries(V.bandSets || {})) {
    const limits = set.map((b) => b.lte)
    if (limits.at(-1) != null) problems.push(`bandSets.${name}: last band needs no limit`)
    if (limits.slice(0, -1).some((x, i, a) => x == null || (i && x <= a[i - 1]))) problems.push(`bandSets.${name}: band limits must rise`)
    for (const b of set) if (!b.handover && !(b.to in V.licences)) problems.push(`bandSets.${name}: unknown licence ${b.to}`)
  }
  for (const [name, list] of Object.entries(V.bandSources || {})) {
    if (!(name in V.bandSets)) problems.push(`bandSources.${name}: unknown band set`)
    list.forEach((s, i) => checkSource(src(s), `bandSources.${name}[${i}]`, problems))
  }
  if (V.documents) {
    for (const k of ['registration', 'licence', 'licence_manufacturing']) for (const d of V.documents[k] || []) if (!docIds.has(d)) problems.push(`documents.${k}: unknown document ${d}`)
    ;(V.documents.sources || []).forEach((s, i) => checkSource(src(s), `documents.sources[${i}]`, problems))
  }

  // facts (questions)
  const factIds = new Set()
  for (const q of graph.facts) {
    const w = `facts.${q.id}`
    if (!q.id || factIds.has(q.id) || q.id === 'check') problems.push(`${w}: missing, duplicate or reserved id`)
    factIds.add(q.id)
    for (const k of [...(q.keys || []), ...(q.alsoClears || [])]) if (!keys.has(k)) problems.push(`${w}: unknown key ${k}`)
    for (const field of ['relevant', 'answered']) lint(q[field], `${w}.${field}`)
    if (q.multi && typeof q.multi === 'object') lint(q.multi, `${w}.multi`)
    if (q.valid && typeof q.valid === 'object') lint(q.valid, `${w}.valid`)
    lintText(q.title, `${w}.title`)
    lintText(q.hint, `${w}.hint`)
    if (q.show && !q.show.values && !q.show.joinKey) lintText(q.show, `${w}.show`)
    for (const [i, c] of (q.value?.cases || []).entries()) lint(c.when, `${w}.value.cases[${i}]`)
    if (q.value?.when) lint(q.value.when, `${w}.value.when`)
    if (q.kind !== 'states' && !(q.values || []).length) problems.push(`${w}: no values`)
    if (q.kind !== 'states' && !q.value && q.valid === undefined) problems.push(`${w}: needs a value spec or a valid rule`)
    const valueIds = new Set()
    for (const v of q.values || []) {
      const vw = `${w}.values.${v.id}`
      if (!v.id || valueIds.has(v.id)) problems.push(`${vw}: missing or duplicate id`)
      valueIds.add(v.id)
      lint(v.when, `${vw}.when`)
      for (const f of ['label', 'example', 'emoji']) lintText(v[f], `${vw}.${f}`)
      if (v.show !== '@label') lintText(v.show, `${vw}.show`)
      for (const k of Object.keys({ ...v.set, ...v.apply?.set })) if (!keys.has(k)) problems.push(`${vw}: sets unknown key ${k}`)
    }
  }

  // edges
  const edgeIds = new Set()
  for (const e of graph.edges) {
    const w = `edges.${e.id}`
    if (!e.id || edgeIds.has(e.id)) problems.push(`${w}: missing or duplicate id`)
    edgeIds.add(e.id)
    if (!RELS.includes(e.rel)) problems.push(`${w}: unknown rel ${e.rel}`)
    if (!STATUSES.includes(e.status)) problems.push(`${w}: status must be one of ${STATUSES.join(', ')}`)
    if (e.when !== undefined) lint(e.when, `${w}.when`)
    lintText(e.message, `${w}.message`)
    lintText(e.fixLabel, `${w}.fixLabel`)
    for (const qid of e.questions || []) if (!factIds.has(qid)) problems.push(`${w}: unknown question ${qid}`)
    if (e.rel === 'implies' && !keys.has(e.key)) problems.push(`${w}: unknown key ${e.key}`)
    if (e.rel === 'forces' && !(e.to in graph.verdict.licences)) problems.push(`${w}: unknown licence ${e.to}`)
    if (e.rel === 'threshold' && !e.bands) problems.push(`${w}: threshold needs bands`)
    if (e.rel === 'threshold' && e.bands) {
      if (!keys.has(e.fact)) problems.push(`${w}: unknown fact ${e.fact}`)
      const limits = e.bands.map((b) => b.lte)
      if (limits.at(-1) != null) problems.push(`${w}: last band needs no limit`)
      if (limits.slice(0, -1).some((x, i, a) => x == null || (i && x <= a[i - 1]))) problems.push(`${w}: band limits must rise`)
      for (const b of e.bands) if (!(b.to in graph.verdict.licences)) problems.push(`${w}: unknown licence ${b.to}`)
    }
    if (e.status === 'expert' && !(e.sources || []).some((s) => s.level === 'A')) problems.push(`${w}: expert status needs a level A source`)
    for (const [i, s] of (e.sources || []).entries()) checkSource(src(s), `${w}.sources[${i}]`, problems)
    if (e.rel === 'licence') {
      checkRule(e.licence, `${w}.licence`)
      for (const c of e.applies?.concepts || []) if (!conceptIds.has(c)) problems.push(`${w}: applies to unknown concept ${c}`)
      for (const g of e.applies?.groups || []) if (!groups.has(g)) problems.push(`${w}: applies to unknown group ${g}`)
    }
    if (e.rel === 'task' && e.concept && !conceptIds.has(e.concept)) problems.push(`${w}: unknown concept ${e.concept}`)
  }

  for (const a of graph.assertions || []) {
    lintCondition(a.never, { defs, keys: a.verdict ? new Set([...keys, '$licence']) : keys, concepts: conceptIds }, `assertions.${a.id}`, problems)
  }
  return problems
}

/** A source's quote must appear verbatim (whitespace-normalised) on the cited page of the saved text. */
function checkSource(s, where, problems) {
  if (!['A', 'B', 'C'].includes(s.level)) return problems.push(`${where}: level must be A, B or C`)
  if (!s.quote) return problems.push(`${where}: missing quote`)
  if (!s.file) return
  const file = path.resolve(LAB_ROOT, s.file)
  if (!existsSync(file)) return problems.push(`${where}: file not found ${s.file}`)
  const pages = readFileSync(file, 'utf8').split('\f')
  const hay = s.page ? pages[s.page - 1] : pages.join(' ')
  if (hay == null || !norm(hay).includes(norm(s.quote))) problems.push(`${where}: quote not found on page ${s.page ?? '(any)'} of ${s.file}`)
}
