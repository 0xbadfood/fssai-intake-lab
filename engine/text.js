// Text templates in graph files. A template is one of:
//   "plain text"
//   { cases: [{ when?, text }] }                               first case whose condition holds; null if none
//   { parts: [{ when?, text }], join, prefix?, empty?, capitalize? }
//        the texts whose conditions hold, joined by `join` ("or" gives "a, b or c"), with `prefix` in front;
//        `empty` replaces the joined text when no part applies.

const orJoin = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}` : xs[0])

export function renderText(t, f, ev) {
  if (t == null || typeof t === 'string') return t ?? null
  if (t.cases) {
    const hit = t.cases.find((c) => ev(c.when, f))
    return hit ? hit.text : null
  }
  if (t.parts) {
    const texts = t.parts.filter((p) => ev(p.when, f)).map((p) => p.text)
    const joined = texts.length ? (t.join === 'or' ? orJoin(texts) : texts.join(t.join ?? '')) : (t.empty ?? '')
    const s = (t.prefix ?? '') + joined
    return t.capitalize && s ? s[0].toUpperCase() + s.slice(1) : s
  }
  throw new Error(`unknown text template: ${JSON.stringify(t).slice(0, 80)}`)
}

/** Conditions used inside a template, for linting. */
export function templateConditions(t) {
  if (!t || typeof t !== 'object') return []
  return [...(t.cases || []), ...(t.parts || [])].map((x) => x.when).filter((w) => w != null)
}
