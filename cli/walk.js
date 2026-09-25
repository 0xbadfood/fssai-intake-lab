// Walks every tap path through the automaton and checks that each one is sensible and ends in a verdict
// (a port of fssai-portal/scripts/check-intake.mjs, driven by the graph's assertions).
// With a portal adapter it also steps the portal's own automaton in lockstep and compares, at every step,
// the rendered question and the facts; at every end, the verdict, form and summary rows; and at sampled
// steps, the result of merging typed-answer interpretations.

const TWO_STATES = ['Maharashtra', 'Karnataka']

/** Stable JSON: sorted keys, undefined dropped. Key order is not meaningful in facts. */
export function canon(x) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, sort(v[k])]))
    return v
  }
  return JSON.stringify(sort(x))
}

// Typed-answer interpretations applied at sampled steps (shapes the model and the cache return, including a
// malformed one seen in production: kob as a string, an activity with a leading space).
export const SAMPLE_INTERPRETATIONS = [
  { choice: [], facts: { activities: ['make'] } },
  { choice: [], facts: { place: 'home' } },
  { choice: [], facts: { annual_sales_rupees: 8000000 } },
  { choice: [], facts: { states: ['Goa', 'kerala'], locations: 'multistate' } },
  { choice: [], facts: { sells_online: true } },
  { choice: ['cook'], facts: { activities: ['cook', 'sell'], trade: ['retail'] } },
  { choice: [], facts: { kob: 'foodService', place: 'premises', trade: ['retail'], states: ['Goa'], implied: ['locations'], importer: false, locations: 'many', activities: [' cook'] } },
  { choice: [], facts: { municipal_registered: true, is_street_vendor: true } },
  { choice: [], facts: { ecommerce_platform: true } },
  { choice: ['t3'], facts: {} },
  { choice: [], facts: { kob: ['manufacturer', 'tradeRetailStorageTransport'], importer: true } },
  { choice: [], facts: { locations: 'one', states: ['Delhi'] } },
]

const stripLabOnly = ({ trail, provisional, expert_option, ...rest }) => rest

export function walkAll(E, V, { portal = null, tree = false, mergeEvery = 0, stopOnParity = false, maxPick = null } = {}) {
  const failures = []
  const parity = []
  const verdicts = {}
  const treeCounts = new Map()
  const stats = { paths: 0, steps: 0, merges: 0 }
  const assertions = E.graph.assertions || []

  function subsets(list) {
    const out = []
    for (let m = 1; m < 1 << list.length; m++) out.push(list.filter((_, i) => m & (1 << i)))
    return out
  }
  function choices(q, f) {
    if (q.kind === 'states') return E.isMulti(q, f) ? [{ states: TWO_STATES }] : [{ states: [TWO_STATES[0]] }]
    const opts = E.optionsFor(q, f)
    if (!E.isMulti(q, f)) return opts.map((o) => ({ optionIds: [o.id] }))
    const normal = opts.filter((o) => !o.exclusive).map((o) => o.id)
    const limit = maxPick ? maxPick(q, f) : Infinity
    return [...subsets(normal).filter((s) => s.length <= limit).map((ids) => ({ optionIds: ids })), ...opts.filter((o) => o.exclusive).map((o) => ({ optionIds: [o.id] }))]
  }
  const label = (q, c) => `${q.id}=${c.states ? (c.states.length > 1 ? '2 states' : '1 state') : c.optionIds.join('+')}`
  const STOP = Symbol('stop')
  const differ = (what, trail, a, b) => {
    parity.push(`${what} differs after ${trail.join(' > ') || '(start)'}\n    lab:    ${a}\n    portal: ${b}`)
    if (stopOnParity) throw STOP
  }

  function comparePortal(f, pf, q, pq, trail) {
    const a = canon(f)
    const b = canon(pf)
    if (a !== b) return differ('facts', trail, a, b), false
    const ra = canon(q && E.render(q, f))
    const rb = canon(pq && portal.render(pq, pf))
    if (ra !== rb) return differ('question', trail, ra, rb), false
    return true
  }

  function sampleMerges(f, pf, q, pq, trail) {
    const interps = [...SAMPLE_INTERPRETATIONS]
    const first = E.optionsFor(q, f)[0]
    if (first) interps.push({ choice: [first.id], facts: {} })
    for (const it of interps) {
      stats.merges++
      const m = E.mergeInterpretation(f, q, it, 'typed answer')
      const pm = portal.mergeInterpretation(pf, pq, it, 'typed answer')
      const a = canon(m)
      const b = canon(pm)
      if (a !== b) return differ(`merge ${JSON.stringify(it)}`, trail, a, b)
      const nq = E.nextQuestion(m)
      const npq = portal.nextQuestion(pm)
      if (canon(nq && E.render(nq, m)) !== canon(npq && portal.render(npq, pm))) {
        return differ(`question after merge ${JSON.stringify(it)}`, trail, canon(nq && E.render(nq, m)), canon(npq && portal.render(npq, pm)))
      }
    }
  }

  function walk(f, pf, trail, seen) {
    stats.steps++
    const q = E.nextQuestion(f)
    const pq = portal ? portal.nextQuestion(pf) : null
    if (portal && !comparePortal(f, pf, q, pq, trail)) return
    if (!q) return finish(f, pf, trail)
    if (trail.length > E.QUESTIONS.length * 2) return failures.push(`no end after ${trail.join(' > ')}`)
    if (portal && mergeEvery && stats.steps % mergeEvery === 0) sampleMerges(f, pf, q, pq, trail)
    const opts = choices(q, f)
    if (!opts.length) return failures.push(`"${E.titleFor(q, f)}" has no options after ${trail.join(' > ')}`)
    for (const c of opts) {
      let next
      let pnext
      let err = null
      let perr = null
      try { next = E.applyTap(f, q, c).facts } catch (e) { err = e.message }
      if (portal) {
        try { pnext = portal.applyTap(pf, pq, c).facts } catch (e) { perr = e.message }
        if (err !== perr) { differ(`tap ${label(q, c)} error`, trail, err, perr); continue }
      }
      if (err) { failures.push(`${label(q, c)} rejected (${err}) after ${trail.join(' > ')}`); continue }
      const step = label(q, c)
      // A question may come back only after "None of these" > "back" or a "Just checking" answer that changed
      // something. Walk each such loop once and prune further repeats; any other repeat is a bug.
      const prev = seen.get(q.id)
      if (prev && q.id !== 'check') {
        const reason = trail.slice(prev.at).some((t) => t.startsWith('check=') || t === 'nonfood=back')
        if (!reason) failures.push(`${q.id} asked again after ${trail.join(' > ')}`)
        if (!reason || prev.count >= 2) continue
      }
      if (q.id === 'check' && trail.filter((t) => t.startsWith('check=')).length >= 3) continue
      walk(next, pnext, [...trail, step], new Map(seen).set(q.id, { count: (prev?.count || 0) + 1, at: trail.length }))
    }
  }

  function finish(f, pf, trail) {
    stats.paths++
    const where = trail.join(' > ')
    for (const a of assertions) if (!a.verdict && E.ev(a.never, f)) failures.push(`forbidden (${a.text}): ${where}`)
    for (const q of E.QUESTIONS) if (E.relevant(q, f) && !E.isAnswerValid(q, f)) failures.push(`invalid ${q.id} answer at end: ${where}`)
    if (E.divergences(f).length) failures.push(`ends with an open check (${E.divergences(f)[0].id}): ${where}`)
    if (canon(E.reconcile(f)) !== canon(f)) failures.push(`reconcile not stable: ${where}`)
    const e = V.verdict(f)
    const licences = V.licenceNames()
    const ok =
      (e.outcome === 'notfood' && !e.licence) ||
      (e.outcome === 'deemed' && !e.licence) ||
      (e.outcome === 'handover' && !e.licence && e.handover?.length) ||
      (licences.includes(e.licence) && ['A', 'B'].includes(V.formKind(e)))
    if (!ok) failures.push(`no verdict (${JSON.stringify(e)}): ${where}`)
    const unasked = (e.missing || []).filter((k) => V.dependsOn(f, k))
    if (unasked.length) failures.push(`verdict depends on ${unasked.join(', ')} but it was never asked: ${where}`)
    if (e.handover?.length) stats.handover = (stats.handover || 0) + 1
    const withLicence = { ...f, $licence: V.licenceId(e) }
    for (const a of assertions) if (a.verdict && E.ev(a.never, withLicence)) failures.push(`${a.text}: ${where}`)
    const key = e.licence || e.outcome
    verdicts[key] = (verdicts[key] || 0) + 1
    if (tree) for (let i = 1; i <= trail.length; i++) treeCounts.set(trail.slice(0, i).join(' > '), (treeCounts.get(trail.slice(0, i).join(' > ')) || 0) + 1)
    // Changing any earlier answer must lead back into a valid path.
    for (const q of E.QUESTIONS) {
      if (q.id === 'check' || !E.answered(q, f) || !E.relevant(q, f)) continue
      const back = E.reconcile(E.clearQuestion(f, q.id))
      if (!E.nextQuestion(back)) failures.push(`changing ${q.id} asks nothing: ${where}`)
    }
    if (portal) {
      const pe = portal.verdict(pf)
      if (canon(stripLabOnly(e)) !== canon(pe)) differ('verdict', trail, canon(stripLabOnly(e)), canon(pe))
      if (V.formKind(e) !== portal.formKind(pe)) differ('form', trail, V.formKind(e), portal.formKind(pe))
      if (canon(E.summary(f)) !== canon(portal.summary(pf))) differ('summary', trail, canon(E.summary(f)), canon(portal.summary(pf)))
    }
  }

  try {
    walk({}, portal ? {} : null, [], new Map())
  } catch (e) {
    if (e !== STOP) throw e
  }
  return { ...stats, verdicts, failures: [...new Set(failures)], parity, tree: treeCounts }
}

/** Wrap the portal's own modules in the same interface (read-only import; nothing in the portal changes). */
export async function portalAdapter(portalDir) {
  const Q = await import(`${portalDir}/src/lib/intakeQuestions.js`)
  const A = await import(`${portalDir}/src/lib/applicationPlan.js`)
  const option = (o) => ({ id: o.id, emoji: o.emoji, label: o.label, example: o.example, ...(o.exclusive ? { exclusive: true } : {}) })
  return {
    nextQuestion: Q.nextQuestion,
    render: (q, f) => ({ id: q.id, kind: q.kind || null, title: Q.titleFor(q, f), hint: Q.hintFor(q, f), multi: Q.isMulti(q, f), options: Q.optionsFor(q, f).map(option) }),
    applyTap: Q.applyTap,
    mergeInterpretation: Q.mergeInterpretation,
    verdict: A.eligibilityFromFacts,
    formKind: A.formKind,
    summary: (f) => Q.QUESTIONS.filter((q) => q.id !== 'check' && q.relevant(f) && q.answered(f)).map((q) => ({ id: q.id, value: q.show(f) })),
  }
}
