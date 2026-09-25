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
//
// An operand x is a fact key, or { len: key } for the length of a list (0 when missing).

export const OPS = ['all', 'any', 'not', 'known', 'empty', 'nonempty', 'has', 'only', 'eq', 'in', 'gt', 'gte', 'lt', 'lte', 'ref', 'implied']

const list = (v) => (Array.isArray(v) ? v : [])

export function makeEvaluator(graph) {
  const defs = graph.defs || {}
  const implies = (graph.edges || []).filter((e) => e.rel === 'implies')

  const operand = (x, f) => (typeof x === 'string' ? f[x] : x && typeof x === 'object' && 'len' in x ? list(f[x.len]).length : undefined)
  const num = (x, f) => {
    const v = operand(x, f)
    return typeof v === 'number' ? v : null
  }

  function ev(c, f) {
    if (c === true || c == null) return true
    if (c === false) return false
    const [op] = Object.keys(c)
    const a = c[op]
    switch (op) {
      case undefined: return true
      case 'all': return a.every((x) => ev(x, f))
      case 'any': return a.some((x) => ev(x, f))
      case 'not': return !ev(a, f)
      case 'known': return f[a] != null
      case 'empty': return list(f[a]).length === 0
      case 'nonempty': return list(f[a]).length > 0
      case 'has': return list(f[a[0]]).includes(a[1])
      case 'only': return list(f[a[0]]).every((x) => a[1].includes(x))
      case 'eq': return operand(a[0], f) === a[1]
      case 'in': return a[1].includes(f[a[0]])
      case 'gt': { const v = num(a[0], f); return v != null && v > a[1] }
      case 'gte': { const v = num(a[0], f); return v != null && v >= a[1] }
      case 'lt': { const v = num(a[0], f); return v != null && v < a[1] }
      case 'lte': { const v = num(a[0], f); return v != null && v <= a[1] }
      case 'ref': return ev(defs[a], f)
      case 'implied': return implies.some((r) => r.key === a && ev(r.when, f))
      default: throw new Error(`unknown condition operator "${op}"`)
    }
  }
  return ev
}

/** Walk a condition and report problems (unknown operators, unknown refs, unknown keys). */
export function lintCondition(c, { defs = {}, keys = new Set() }, where, problems) {
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
      return a.forEach((x, i) => lintCondition(x, { defs, keys }, `${where}.${op}[${i}]`, problems))
    case 'not': return lintCondition(a, { defs, keys }, `${where}.not`, problems)
    case 'known': case 'empty': case 'nonempty': case 'implied': return key(a)
    case 'has': case 'only': case 'eq': case 'in': case 'gt': case 'gte': case 'lt': case 'lte':
      if (!Array.isArray(a) || a.length !== 2) return problems.push(`${where}: ${op} needs [operand, value]`)
      return key(a[0])
    case 'ref': if (!(a in defs)) problems.push(`${where}: unknown ref "${a}"`); return
    default: problems.push(`${where}: unknown operator "${op}"`)
  }
}
