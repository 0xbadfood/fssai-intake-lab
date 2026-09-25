// The verdict (DESIGN.md §3.3): fixed code that reads only facts and graph edges. No model is involved.
//   1. not food  2. deemed (+ opt-in)  3. forced licences  4. thresholds  5. highest of 3 and 4  6. notes
// Every result carries its trail (the edges that fired) and `provisional` when any of them is not expert-reviewed.
// For v1 the returned shape matches the portal's eligibilityFromFacts(), plus trail / provisional / expert_option.
import { makeEvaluator } from './conditions.js'

export function createVerdict(graph) {
  const ev = makeEvaluator(graph)
  const V = graph.verdict
  const edges = (rel) => graph.edges.filter((e) => e.rel === rel)
  const rank = (id) => V.rank.indexOf(id)
  const name = (id) => V.licences[id]

  function verdict(f = {}) {
    const trail = []
    const done = (result) => {
      const provisional = trail.some((e) => e.status !== 'expert')
      return { ...result, trail: trail.map((e) => e.id), provisional, expert_option: provisional }
    }
    const kob = f.kob || []

    const notfood = edges('outcome').find((e) => e.outcome === 'notfood' && ev(e.when, f))
    if (notfood) {
      trail.push(notfood)
      return done({ outcome: 'notfood', licence: null, reasons: [...notfood.reasons], guidance: notfood.guidance })
    }

    const deemed = edges('outcome').find((e) => e.outcome === 'deemed' && ev(e.when, f))
    let result
    if (deemed) {
      trail.push(deemed)
      result = {
        outcome: 'deemed', licence: null, overrideApplied: false, specialCategoriesTriggered: [], kob,
        reasons: [...deemed.reasons], guidance: deemed.guidance, upsell: deemed.upsell,
      }
      if (deemed.optIn && ev(deemed.optIn.when, f)) {
        return done({ ...result, outcome: 'optin', licence: name(deemed.optIn.licence), reasons: [...result.reasons, deemed.optIn.reason] })
      }
    } else {
      const reasons = []
      for (const r of edges('reason')) if (ev(r.when, f)) { trail.push(r); reasons.push(r.text) }

      const forced = edges('forces').filter((e) => ev(e.when, f))
      const bands = edges('threshold').map((t) => {
        const v = f[t.fact] ?? t.default
        return { edge: t, band: t.bands.find((b) => b.lte == null || v <= b.lte) }
      })
      if (forced.length) {
        forced.forEach((e) => trail.push(e))
        const top = forced.reduce((a, e) => (rank(e.to) > rank(a) ? e.to : a), forced[0].to)
        const labels = forced.filter((e) => e.to === top).map((e) => e.label).join(', ')
        result = {
          outcome: 'override', licence: name(top), overrideApplied: true,
          specialCategoriesTriggered: forced.filter((e) => e.to === top).map((e) => e.category), kob,
          reasons: [...reasons, ...V.forcedReasons.map((s) => s.replace('{to}', name(top)).replace('{labels}', labels))],
          effectiveDate: V.effectiveDate,
        }
        // A threshold above the forced licence would still win (Central beats State beats Registration).
        const higher = bands.filter((b) => rank(b.band.to) > rank(top))
        if (higher.length) {
          const b = higher.reduce((a, x) => (rank(x.band.to) > rank(a.band.to) ? x : a))
          trail.push(b.edge)
          result = { ...result, licence: name(b.band.to), reasons: [...result.reasons, b.band.text] }
        }
      } else {
        const b = bands.reduce((a, x) => (!a || rank(x.band.to) > rank(a.band.to) ? x : a), null)
        if (b) trail.push(b.edge)
        result = {
          outcome: 'turnover', licence: b ? name(b.band.to) : name(V.rank[0]), overrideApplied: false, specialCategoriesTriggered: [],
          reasons: [...reasons, ...(b ? [b.band.text] : [])], effectiveDate: V.effectiveDate, kob,
        }
      }
    }

    const notes = edges('note').filter((e) => ev(e.when, f))
    notes.forEach((e) => trail.push(e))
    if (notes.length) result = { ...result, reasons: [...result.reasons, ...notes.map((e) => e.text)] }
    return done(result)
  }

  /** 'A' (registration), 'B' (state/central licence) or null (nothing to file). */
  const formKind = (e) => (!e?.licence ? null : e.licence === name('registration') ? 'A' : 'B')

  /** The licence id ('registration' | 'state' | 'central') behind a verdict, or null. */
  const licenceId = (e) => Object.keys(V.licences).find((k) => V.licences[k] === e?.licence) || null

  return { verdict, formKind, licenceId }
}
