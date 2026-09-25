// Verdict model "kob" (graph v2): licensing by FoSCoS Kind of Business (DESIGN.md §3.3).
//   1. not food → nothing to file   2. deemed street vendor (+ opt-in)
//   3. for each kind of business the user matched: a place rule (airport, railway, central government) if one
//      applies, otherwise the concept's own rule, inherited through `is_a` — a fixed licence or turnover bands
//   4. the highest licence wins (graph `rank`), with its annual fee
//   5. tasks (head office, more premises), notes, and the documents to upload
// Anything the rules cannot place becomes a handover reason: the likely result is still shown, with an expert option.
import { makeEvaluator } from './conditions.js'

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(n))

export function createKobVerdict(graph) {
  const ev = makeEvaluator(graph)
  const V = graph.verdict
  const concepts = new Map((graph.concepts || []).map((c) => [c.id, c]))
  const edges = (rel) => graph.edges.filter((e) => e.rel === rel)
  const rank = (id) => V.rank.indexOf(id)
  const name = (id) => V.licences[id]?.name ?? null

  /** The nearest concept (itself first, then up the is_a chain, breadth first) that carries a licence rule. */
  function licensed(id) {
    const queue = [id]
    const seen = new Set()
    while (queue.length) {
      const c = concepts.get(queue.shift())
      if (!c || seen.has(c.id)) continue
      seen.add(c.id)
      if (c.licence) return c
      queue.push(...(c.is_a || []))
    }
    return null
  }
  const ancestorsOf = (id) => {
    const out = []
    const walk = (x) => { for (const p of concepts.get(x)?.is_a || []) if (!out.includes(p)) { out.push(p); walk(p) } }
    walk(id)
    return out
  }
  const inGroupOrConcept = (applies, id) => {
    if (!applies) return true
    const c = concepts.get(id)
    const family = [id, ...ancestorsOf(id)]
    return (applies.groups || []).includes(c?.group) || (applies.concepts || []).some((x) => family.includes(x))
  }

  function bandText(set, band) {
    const i = set.indexOf(band)
    const lo = i > 0 ? set[i - 1].lte : null
    if (band.lte != null && lo == null) return `turnover up to ₹${fmt(band.lte)} crore`
    if (band.lte != null) return `turnover ₹${fmt(lo)}–${fmt(band.lte)} crore`
    return lo == null ? 'any turnover' : `turnover above ₹${fmt(lo)} crore`
  }

  /** Evaluate a licence rule. Returns { to, fee, basis } or { handover }; records facts it needed but lacked. */
  function evalRule(rule, f, missing) {
    if (rule.cases) {
      const hit = rule.cases.find((c) => ev(c.when, f))
      return hit ? evalRule(hit, f, missing) : { handover: 'No licence rule matched.' }
    }
    if (rule.fixed) return { to: rule.fixed, fee: rule.fee ?? null, basis: 'whatever the turnover' }
    if (rule.bands) {
      const set = V.bandSets[rule.bands]
      let t = f[V.turnover]
      const assumed = typeof t !== 'number'
      if (assumed) {
        missing.add(V.turnover)
        t = 0
      }
      const band = set.find((b) => b.lte == null || t <= b.lte)
      if (band.handover) return { handover: band.handover, bands: rule.bands, assumed }
      return { to: band.to, fee: band.fee ?? null, basis: bandText(set, band), bands: rule.bands, assumed }
    }
    return { handover: 'No licence rule.' }
  }

  /**
   * Licence for one kind of business. A place rule (airport, railway, central government) and the concept's own
   * rule both apply and the higher licence wins, so a place never lowers a Central-only kind of business; on a
   * tie the place rule wins, because its fee is specific to that place (e.g. ₹2,000 railway Central Licence).
   */
  function forConcept(id, f, missing) {
    const c = concepts.get(id)
    const out = { concept: id, label: c?.label ?? id }
    const placeRules = edges('licence').filter((e) => ev(e.when, f))
    const place = placeRules.find((e) => inGroupOrConcept(e.applies, id))
    const owner = licensed(id)
    const own = owner ? { via: `concept:${owner.id}`, ...evalRule(owner.licence, f, missing) } : null
    const atPlace = place ? { via: place.id, ...evalRule(place.licence, f, missing), text: place.text } : null
    if (atPlace && (!own?.to || rank(atPlace.to) >= rank(own.to))) return { ...out, ...atPlace }
    if (!own) return { ...out, handover: `No licence rule for ${out.label}.` }
    const uncovered = !place && placeRules.find((e) => e.otherwise)
    return { ...out, ...own, ...(uncovered && !own.handover ? { handover: uncovered.otherwise, likely: true } : {}) }
  }

  function documentsFor(licenceId, kobs) {
    const D = V.documents
    const label = (id) => ({ id, label: D.catalogue[id] })
    if (!licenceId) return []
    if (V.licences[licenceId].form === 'A') return D.registration.map(label)
    const ids = new Set(kobs.some((k) => [k.concept, ...ancestorsOf(k.concept)].some((x) => concepts.get(x)?.manufacturing)) ? D.licence_manufacturing : D.licence)
    for (const k of kobs) for (const x of [k.concept, ...ancestorsOf(k.concept)]) for (const d of concepts.get(x)?.docs || []) ids.add(d)
    return [...ids].map(label)
  }

  function verdict(f = {}) {
    const trail = []
    const statusOf = new Map()
    const hit = (id, status) => { trail.push(id); statusOf.set(id, status ?? 'draft') }
    const missing = new Set()
    const done = (r) => {
      const provisional = trail.some((id) => statusOf.get(id) !== 'expert')
      return { ...r, trail, provisional, expert_option: provisional || (r.handover || []).length > 0, missing: [...missing] }
    }

    const notfood = edges('outcome').find((e) => e.outcome === 'notfood' && ev(e.when, f))
    if (notfood) {
      hit(notfood.id, notfood.status)
      return done({ outcome: 'notfood', licence: null, licence_id: null, reasons: [...notfood.reasons], guidance: notfood.guidance, handover: [] })
    }
    const deemed = edges('outcome').find((e) => e.outcome === 'deemed' && ev(e.when, f))
    if (deemed) {
      hit(deemed.id, deemed.status)
      const base = { outcome: 'deemed', licence: null, licence_id: null, fee: null, reasons: [...deemed.reasons], guidance: deemed.guidance, upsell: deemed.upsell, handover: [] }
      if (deemed.optIn && ev(deemed.optIn.when, f)) {
        const to = deemed.optIn.licence
        return done({ ...base, outcome: 'optin', licence: name(to), licence_id: to, reasons: [...base.reasons, deemed.optIn.reason], documents: documentsFor(to, []) })
      }
      return done(base)
    }

    const reasons = []
    for (const r of edges('reason')) if (ev(r.when, f)) { hit(r.id, r.status); reasons.push(r.text) }
    const handover = []
    if (f.unknown_kind) handover.push(V.handover.unknown_kind)

    const kobs = (f.business || []).map((id) => forConcept(id, f, missing)).filter((k) => concepts.get(k.concept)?.licence || k.to || k.handover || k.via)
    for (const k of kobs) {
      if (k.via?.startsWith('concept:')) hit(k.via, concepts.get(k.via.slice(8))?.status)
      else if (k.via) hit(k.via, graph.edges.find((e) => e.id === k.via)?.status)
      if (k.bands) hit(`bands:${k.bands}`, 'draft')
      if (k.handover) handover.push(`${k.label}: ${k.handover}`)
    }
    const placed = kobs.filter((k) => k.to)
    const top = placed.reduce((a, k) => (!a || rank(k.to) > rank(a.to) || (k.to === a.to && (k.fee ?? 0) > (a.fee ?? 0)) ? k : a), null)
    for (const k of kobs) {
      if (k.to && k.assumed && top && top !== k) reasons.push(`${k.label}: covered by the ${name(top.to)} (turnover not needed)`)
      else if (k.to) reasons.push(`${k.label}: ${name(k.to)} (${k.basis})${k.text ? `. ${k.text}` : ''}`)
    }

    const tasks = []
    for (const t of edges('task')) {
      if (!ev(t.when, f)) continue
      hit(t.id, t.status)
      if (t.concept) {
        const c = concepts.get(t.concept)
        const r = evalRule(c.licence, f, new Set())
        tasks.push({ id: t.id, task: t.concept, label: c.label, licence: name(r.to), licence_id: r.to, fee: r.fee, text: t.text, documents: documentsFor(r.to, [{ concept: t.concept }]) })
      } else tasks.push({ id: t.id, task: t.offer, label: t.label ?? t.offer, text: t.text })
    }
    const notes = edges('note').filter((e) => ev(e.when, f))
    notes.forEach((e) => hit(e.id, e.status))

    return done({
      outcome: top ? 'licence' : 'handover',
      licence: top ? name(top.to) : null,
      licence_id: top?.to ?? null,
      fee: top?.fee ?? null,
      kobs: kobs.map(({ concept, label, to, fee, basis, via, handover: h }) => ({ concept, label, licence_id: to ?? null, fee: fee ?? null, basis: basis ?? null, via: via ?? null, ...(h ? { handover: h } : {}) })),
      reasons: [...reasons, ...notes.map((e) => e.text)],
      tasks,
      documents: documentsFor(top?.to, kobs),
      handover,
      effectiveDate: V.effectiveDate,
    })
  }

  /** Does the verdict depend on this fact? (It would be missing if the fact were unknown.) */
  // Would the answer to `key` change the result? The verdict is re-run with the fact at every band boundary
  // (and above the highest); the fact is needed only if the licence, fee, outcome or handover differs.
  // The automaton asks this for every question on every step, so answers are cached by facts.
  const probes = [...new Set(Object.values(V.bandSets).flat().map((b) => b.lte).filter((x) => x != null))].sort((a, b) => a - b)
  probes.unshift(0)
  probes.push(probes.at(-1) + 1)
  const dependsCache = new Map()
  function dependsOn(f, key) {
    const k = `${key}|${JSON.stringify(f)}`
    let hit = dependsCache.get(k)
    if (hit === undefined) {
      const results = new Set(probes.map((t) => {
        const v = verdict({ ...f, [key]: t })
        return JSON.stringify([v.outcome, v.licence_id, v.fee, v.handover.length > 0])
      }))
      hit = results.size > 1
      if (dependsCache.size > 100000) dependsCache.clear()
      dependsCache.set(k, hit)
    }
    return hit
  }

  const formKind = (e) => (e?.licence_id ? V.licences[e.licence_id]?.form ?? null : null)
  const licenceId = (e) => e?.licence_id ?? null
  const licenceNames = () => Object.values(V.licences).map((l) => l.name)

  return { verdict, formKind, licenceId, licenceNames, dependsOn }
}
