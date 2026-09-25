// Efficacy report for a cache-fill run: yield, blind agreement, confusions, variety, languages, throughput, samples.

const ratio = (s) => {
  const [x, y] = String(s).split('/').map(Number)
  return y ? x / y : 0
}
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '—')
const words = (s) => s.split(' ').filter(Boolean)
const jaccard = (a, b) => {
  const A = new Set(a)
  const B = new Set(b)
  const inter = [...A].filter((x) => B.has(x)).length
  return A.size + B.size - inter ? inter / (A.size + B.size - inter) : 0
}
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0
}
// The portal's normalizeText keeps only a-z/0-9 (src/lib/answerRules.js).
const portalNorm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9.'\s]/g, ' ').replace(/\s+/g, ' ').trim()

export function report(records, run) {
  const L = []
  const table = (head, rows) => {
    L.push(`| ${head.join(' | ')} |`, `|${head.map((h, i) => (i ? '---:' : '---')).join('|')}|`)
    for (const r of rows) L.push(`| ${r.join(' | ')} |`)
    L.push('')
  }
  const targeted = (r) => r.review.intent.length > 0
  L.push(`# Cache-fill pilot: ${run.run}`, '')
  L.push(`Steps: ${run.steps.join(', ')} · ${run.per_option} answers per option + ${run.nomatch} no-match per step · graph v${run.graph.version} · ${run.seconds.toFixed(0)} s`, '')

  // Yield per step
  L.push('## Yield', '', 'Agreed = the blind reviewer chose exactly the intended option (or nothing, for no-match answers). Strong = the blind self-check agreed too. Relabelled = both blind classifiers agreed, with high confidence, on a different option than the planner intended; kept under their label and marked.', '')
  const stepOf = (r) => r.review.view || r.step
  const steps = [...new Set(records.map(stepOf))]
  table(['Step', 'Answers', 'Agreed', 'Strong', 'No-match recognised', 'Relabelled', 'Records kept', 'Duplicates', 'Errors'], steps.map((s) => {
    const rs = records.filter((r) => stepOf(r) === s)
    const t = rs.filter(targeted)
    const n = rs.filter((r) => !targeted(r))
    return [s, rs.length, `${t.filter((r) => r.review.agree).length}/${t.length} (${pct(t.filter((r) => r.review.agree).length, t.length)})`,
      pct(t.filter((r) => r.review.strong).length, t.length),
      `${n.filter((r) => r.review.agree).length}/${n.length} (${pct(n.filter((r) => r.review.agree).length, n.length)})`,
      rs.filter((r) => r.review.relabelled).length,
      `${rs.filter((r) => r.status === 'model-reviewed').length} (${pct(rs.filter((r) => r.status === 'model-reviewed').length, rs.length)})`,
      rs.filter((r) => r.review.duplicate).length, rs.filter((r) => r.review.error).length]
  }))

  // Agreement between the two blind classifiers
  const both = records.filter((r) => r.review.reviewer && r.review.selfcheck)
  const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x))
  L.push(`Reviewer and self-check (both blind) agree on ${pct(both.filter((r) => sameSet(r.review.reviewer, r.review.selfcheck)).length, both.length)} of ${both.length} answers.`, '')

  // Per option
  L.push('## Per option', '', 'Low yield means answers written for this option are often read as another one: a sign of overlapping options (worth showing the expert) or of weak generation.', '')
  const opts = [...new Set(records.filter(targeted).map((r) => `${stepOf(r)}:${r.review.intent.join('+')}`))]
  table(['Step:option', 'Accepted', 'Most often read as'], opts.map((k) => {
    const [s, o] = k.split(':')
    const rs = records.filter((r) => stepOf(r) === s && r.review.intent.join('+') === o)
    const wrong = rs.filter((r) => !r.review.agree).map((r) => (r.review.reviewer?.length ? r.review.reviewer.join('+') : 'none'))
    const top = Object.entries(wrong.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([x, n]) => `${x} (${n})`).join(', ')
    return [k, `${rs.filter((r) => r.review.agree).length}/${rs.length}`, top || '—']
  }).sort((a, b) => ratio(a[1]) - ratio(b[1])))

  // Styles and languages
  L.push('## Styles and languages', '')
  const styles = [...new Set(records.map((r) => r.review.style || '?'))]
  table(['Style', 'Answers', 'Accepted'], styles.map((st) => {
    const rs = records.filter((r) => (r.review.style || '?') === st)
    return [st, rs.length, pct(rs.filter((r) => r.review.agree).length, rs.length)]
  }))
  const deva = records.filter((r) => /[ऀ-ॿ]/.test(r.text))
  const langs = records.reduce((m, r) => ((m[r.lang || '?'] = (m[r.lang || '?'] || 0) + 1), m), {})
  L.push(`Languages: ${Object.entries(langs).map(([k, v]) => `${k} ${v}`).join(', ')}. Answers in Devanagari: ${deva.length}; the portal's text normalisation turns ${deva.filter((r) => !portalNorm(r.text)).length} of them into an empty cache key.`, '')

  // Variety
  L.push('## Variety', '')
  const byText = new Map()
  const bySig = new Map()
  for (const r of records) {
    byText.set(r.text_norm, (byText.get(r.text_norm) || 0) + 1)
    bySig.set(`${stepOf(r)}|${r.token_sig}`, (bySig.get(`${stepOf(r)}|${r.token_sig}`) || 0) + 1)
  }
  const sims = []
  for (const k of opts) {
    const [s, o] = k.split(':')
    const toks = records.filter((r) => stepOf(r) === s && r.review.intent.join('+') === o).map((r) => words(r.text_norm))
    for (let i = 0; i < toks.length; i++) for (let j = i + 1; j < toks.length; j++) sims.push(jaccard(toks[i], toks[j]))
  }
  const lens = records.map((r) => words(r.text_norm).length)
  const vocab = new Set(records.flatMap((r) => words(r.text_norm)))
  table(['Measure', 'Value'], [
    ['Exact duplicates (same normalised text)', [...byText.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0)],
    ['Same words, any order (token signature)', [...bySig.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0)],
    ['Mean word overlap between answers for the same option (Jaccard, lower = more varied)', (sims.reduce((a, x) => a + x, 0) / (sims.length || 1)).toFixed(2)],
    ['Answer length in words (10th / median / 90th percentile)', `${quantile(lens, 0.1)} / ${quantile(lens, 0.5)} / ${quantile(lens, 0.9)}`],
    ['Distinct words', vocab.size],
  ])

  // Throughput
  L.push('## Throughput', '')
  table(['Model', 'Calls', 'Failures (retried)', 'Prompt tokens', 'Output tokens', 'Mean s/call'], Object.entries(run.usage).map(([m, u]) => [m, u.calls, u.failures, u.prompt_tokens, u.completion_tokens, (u.seconds / (u.calls || 1)).toFixed(2)]))
  const accepted = records.filter((r) => r.status === 'model-reviewed').length
  L.push(`${accepted} accepted records in ${run.seconds.toFixed(0)} s (${(accepted / (run.seconds / 60)).toFixed(0)} per minute).`, '')

  // Samples
  L.push('## Samples', '', 'Accepted (first 4 per step by id):', '')
  for (const s of steps) {
    for (const r of records.filter((x) => stepOf(x) === s && x.status === 'model-reviewed').sort((a, b) => a.id.localeCompare(b.id)).slice(0, 4)) {
      L.push(`- \`${s}\` → ${r.targets.length ? r.targets.join('+') : 'none'} · ${r.review.style} · "${r.text}"`)
    }
  }
  L.push('', 'Disagreements (intent → blind reviewer / self-check), first 40:', '')
  for (const r of records.filter((x) => !x.review.agree && !x.review.error).slice(0, 40)) {
    L.push(`- \`${r.step}\` ${r.review.intent.join('+') || 'none'} → ${r.review.reviewer?.join('+') || 'none'} / ${r.review.selfcheck?.join('+') || 'none'} · "${r.text}"`)
  }
  L.push('')
  return L.join('\n')
}
