// Condition language for graph files (DESIGN.md §2.4). Conditions are plain JSON, never code.
//
//   true | {}                          always
//   { all: [c...] } { any: [c...] } { not: c }
//   { known: key }                     value is not null/undefined
//   { empty: key } { nonempty: key }   list is empty (or missing) / has items
//   { has: [key, v] }                  list contains v
//   { only: [key, [v...]] }            every list item is one of these (an empty or missing list passes)
//   { eq: [x, literal] }               strict equality
//   { in: [key, [literal...]] }
//   { gt|gte|lt|lte: [x, number] }     false unless x is a number
//   { ref: name }                      a named condition from graph.defs
//   { implied: key }                   an `implies` edge currently fills this key
//   { matched: concept }               facts.business holds this concept or one that `is_a` it (graph v2)
//   { needs: key }                     the verdict depends on this fact (supplied by the engine, graph v2)
//
// An operand x is a fact key, or { len: key } for the length of a list (0 when missing).

export const OPS = ['all', 'any', 'not', 'known', 'empty', 'nonempty', 'has', 'only', 'eq', 'in', 'gt', 'gte', 'lt', 'lte', 'ref', 'implied', 'matched', 'needs']

const list = (v) => (Array.isArray(v) ? v : [])

/** concept id -> set of itself and every concept it `is_a`, transitively. */
export function isAClosure(concepts = []) {
  const byId = new Map(concepts.map((c) => [c.id, c]))
  const memo = new Map()
  const up = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id)
    const out = new Set([id])
    if (!seen.has(id)) for (const p of byId.get(id)?.is_a || []) for (const x of up(p, new Set([...seen, id]))) out.add(x)
    memo.set(id, out)
    return out
  }
  for (const c of concepts) up(c.id)
  return (id) => memo.get(id) || up(id)
}

export function makeEvaluator(graph, extra = {}) {
  const defs = graph.defs || {}
  const implies = (graph.edges || []).filter((e) => e.rel === 'implies')
  const ancestors = isAClosure(graph.concepts)

  const operand = (x) => (typeof x === 'string' ? (f) => f[x] : x && typeof x === 'object' && 'len' in x ? (f) => list(f[x.len]).length : () => undefined)
  const numeric = (x, cmp) => {
    const get = operand(x)
    return (f) => {
      const v = get(f)
      return typeof v === 'number' && cmp(v)
    }
  }

  // Each condition object is compiled once into a closure (conditions are evaluated millions of times in a walk).
  const compiled = new WeakMap()
  function compile(c) {
    if (c === true || c == null) return () => true
    if (c === false) return () => false
    let fn = compiled.get(c)
    if (fn) return fn
    const [op] = Object.keys(c)
    const a = c[op]
    switch (op) {
      case undefined: fn = () => true; break
      case 'all': { const parts = a.map(compile); fn = (f) => parts.every((p) => p(f)); break }
      case 'any': { const parts = a.map(compile); fn = (f) => parts.some((p) => p(f)); break }
      case 'not': { const inner = compile(a); fn = (f) => !inner(f); break }
      case 'known': fn = (f) => f[a] != null; break
      case 'empty': fn = (f) => list(f[a]).length === 0; break
      case 'nonempty': fn = (f) => list(f[a]).length > 0; break
      case 'has': fn = (f) => list(f[a[0]]).includes(a[1]); break
      case 'only': fn = (f) => list(f[a[0]]).every((x) => a[1].includes(x)); break
      case 'eq': { const get = operand(a[0]); fn = (f) => get(f) === a[1]; break }
      case 'in': fn = (f) => a[1].includes(f[a[0]]); break
      case 'gt': fn = numeric(a[0], (v) => v > a[1]); break
      case 'gte': fn = numeric(a[0], (v) => v >= a[1]); break
      case 'lt': fn = numeric(a[0], (v) => v < a[1]); break
      case 'lte': fn = numeric(a[0], (v) => v <= a[1]); break
      case 'ref': fn = (f) => compile(defs[a])(f); break
      case 'implied': fn = (f) => implies.some((r) => r.key === a && compile(r.when)(f)); break
      case 'matched': fn = (f) => list(f.business).some((b) => ancestors(b).has(a)); break
      case 'needs':
        if (!extra.needs) throw new Error('condition "needs" requires the engine (verdict) hook')
        fn = (f) => extra.needs(a, f)
        break
      default: throw new Error(`unknown condition operator "${op}"`)
    }
    compiled.set(c, fn)
    return fn
  }

  const ev = (c, f) => compile(c)(f)
  return ev
}

/** Walk a condition and report problems (unknown operators, unknown refs, unknown keys). */
export function lintCondition(c, { defs = {}, keys = new Set(), concepts = null }, where, problems) {
  if (c === true || c === false || c == null) return
  if (typeof c !== 'object' || Array.isArray(c)) return problems.push(`${where}: condition must be an object`)
  const ops = Object.keys(c)
  if (ops.length > 1) problems.push(`${where}: one operator per object, got ${ops.join(', ')}`)
  if (!ops.length) return
  const [op] = ops
  const a = c[op]
  const key = (k) => {
    if (typeof k === 'object' && k && 'len' in k) k = k.len
    if (typeof k === 'string' && !keys.has(k)) problems.push(`${where}: unknown key "${k}"`)
  }
  switch (op) {
    case 'all': case 'any':
      if (!Array.isArray(a)) return problems.push(`${where}: ${op} needs a list`)
      return a.forEach((x, i) => lintCondition(x, { defs, keys, concepts }, `${where}.${op}[${i}]`, problems))
    case 'not': return lintCondition(a, { defs, keys, concepts }, `${where}.not`, problems)
    case 'known': case 'empty': case 'nonempty': case 'implied': case 'needs': return key(a)
    case 'matched': if (!concepts?.has(a)) problems.push(`${where}: unknown concept "${a}"`); return
    case 'has': case 'only': case 'eq': case 'in': case 'gt': case 'gte': case 'lt': case 'lte':
      if (!Array.isArray(a) || a.length !== 2) return problems.push(`${where}: ${op} needs [operand, value]`)
      return key(a[0])
    case 'ref': if (!(a in defs)) problems.push(`${where}: unknown ref "${a}"`); return
    default: problems.push(`${where}: unknown operator "${op}"`)
  }
}
