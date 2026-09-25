// The fixed conversation automaton (DESIGN.md §3). It knows nothing about food businesses: every question,
// option, condition and consistency rule comes from the graph. The conversation state is derived from the
// facts alone (nextQuestion(facts)), so any application can be resumed, replayed or audited.
//
// v1 reproduces fssai-portal/src/lib/intakeQuestions.js exactly (cli `walk --parity` checks it path by path).
import { makeEvaluator } from './conditions.js'
import { renderText } from './text.js'

export function createAutomaton(graph) {
  const ev = makeEvaluator(graph)
  const text = (t, f) => renderText(t, f, ev)
  const rules = graph.edges.filter((e) => e.rel === 'implies' || e.rel === 'unlikely')
  const RAW = graph.facts
  const byId = new Map(RAW.map((q) => [q.id, q]))
  const keySpec = new Map(graph.keys.map((k) => [k.id, k]))
  const listEnums = Object.fromEntries(graph.keys.filter((k) => k.enum).map((k) => [k.id, k.enum]))

  // ---------- States ----------

  const STATE_NAMES = graph.enums.states
  const ALIASES = graph.enums.stateAliases || {}
  function matchState(value) {
    const t = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!t) return null
    for (const [alias, name] of Object.entries(ALIASES)) if (t.includes(alias)) return name
    return [...STATE_NAMES].sort((a, b) => b.length - a.length).find((s) => t.includes(s.toLowerCase())) || null
  }

  // ---------- Question helpers ----------

  const call = (x, f) => (typeof x === 'boolean' ? x : x == null ? false : ev(x, f))
  const isCheck = (q) => q.id === 'check'
  const relevant = (q, f) => (isCheck(q) ? divergences(f).length > 0 : ev(q.relevant, f))
  const answered = (q, f) => (isCheck(q) ? false : ev(q.answered, f))
  const isMulti = (q, f = {}) => (isCheck(q) ? false : call(q.multi, f))
  const titleFor = (q, f = {}) => (isCheck(q) ? checkTitle(f) : text(q.title, f))
  const hintFor = (q, f = {}) => (isCheck(q) ? 'Tap the one that is right.' : text(q.hint, f) || null)

  function renderOption(v, f) {
    const o = { id: v.id, emoji: text(v.emoji, f), label: text(v.label, f), example: text(v.example, f) }
    if (v.exclusive) o.exclusive = true
    return o
  }
  function optionsFor(q, f = {}) {
    if (isCheck(q)) return checkOptions(f)
    return (q.values || []).filter((v) => ev(v.when, f)).map((v) => renderOption(v, f))
  }

  /** The option ids the current facts represent (used to check an answer is still allowed). */
  function valueOf(q, f) {
    const spec = q.value
    if (!spec) return null
    if (spec.cases) return [spec.cases.find((c) => ev(c.when, f)).id]
    if (spec.when && !ev(spec.when, f)) return null
    const v = f[spec.key]
    if (Array.isArray(v)) return v.length ? v : spec.empty ? [spec.empty] : null
    if (v == null) return spec.default ? [spec.default] : null
    return [v]
  }

  function valueShow(q, id, f) {
    const v = (q.values || []).find((x) => x.id === id)
    if (!v) return undefined
    if (v.show === '@label' || v.show == null) return text(v.label, f)
    return text(v.show, f)
  }
  /** One-line summary of a question's answer ("Cooks & serves food · Imports food"). */
  function show(q, f) {
    const s = q.show
    if (!s) return ''
    if (s.joinKey) return (f[s.joinKey] || []).join(s.sep ?? ', ')
    if (s.values) {
      const v = f[s.values]
      const ids = Array.isArray(v) ? v : v == null ? [] : [v]
      if (!ids.length) return s.empty ?? ''
      return ids.map((id) => valueShow(q, id, f)).join(s.join ?? ', ')
    }
    return text(s, f)
  }

  /** The facts patch for tapped option ids. */
  function apply(q, ids, f) {
    const picked = ids.map((id) => q.values.find((v) => v.id === id))
    const own = picked.find((v) => v.apply)
    const patch = {}
    const unset = (keys) => keys?.forEach((k) => { patch[k] = undefined })
    const set = (obj, id) => {
      for (const [k, v] of Object.entries(obj || {})) patch[k] = v === '$id' ? id : v
    }
    if (own) {
      set(own.apply.set, own.id)
      unset(own.apply.unset)
      return patch
    }
    const a = q.apply || {}
    if (a.list) patch[a.list] = ids
    if (a.key) patch[a.key] = ids[0]
    set(a.set, ids[0])
    for (const v of picked) set(v.set, v.id)
    unset(a.unset)
    return patch
  }

  // ---------- Consistency: implied answers, unlikely combinations, contradictions ----------

  function impliedBy(f, key) {
    return rules.some((r) => r.rel === 'implies' && r.key === key && ev(r.when, f))
  }

  /** Open issues, in order: contradictions from typed answers first, then rule breaks the user has not confirmed. */
  function divergences(f = {}) {
    const out = (f.conflicts || []).map((c) => ({ ...c, id: `conflict:${c.questionId}`, kind: 'conflict' }))
    for (const r of rules) {
      if (!ev(r.when, f)) continue
      if (r.rel === 'implies' ? f[r.key] != null && f[r.key] !== r.value : !(f.confirmed || []).includes(r.id)) {
        out.push({ ...r, kind: r.rel === 'implies' ? 'implied' : 'unlikely' })
      }
    }
    return out
  }

  /** Fill implied answers; drop ones whose reason no longer holds (e.g. moved from home kitchen to a shop). */
  function applyImplied(facts) {
    const f = { ...facts }
    let marks = [...(f.implied || [])]
    for (const key of marks) if (!impliedBy(f, key)) delete f[key]
    marks = marks.filter((key) => impliedBy(f, key))
    for (const r of rules) {
      if (r.rel === 'implies' && ev(r.when, f) && f[r.key] == null) {
        f[r.key] = r.value
        if (!marks.includes(r.key)) marks.push(r.key)
      }
    }
    if (marks.length) f.implied = marks
    else delete f.implied
    return f
  }

  const clearPatch = (qid) => Object.fromEntries((byId.get(qid)?.keys || []).map((k) => [k, undefined]))

  function checkTitle(f) {
    const d = divergences(f)[0]
    if (!d) return 'Just checking'
    if (d.kind !== 'conflict') return text(d.message, f)
    return d.added ? `You also mentioned "${d.added}". Should I add it?` : `Earlier you said "${d.was}", but that sounds like "${d.now}". Which is right?`
  }

  function checkOptions(f) {
    const d = divergences(f)[0]
    if (!d) return []
    if (d.kind === 'conflict' && d.added) {
      return [
        { id: 'switch', emoji: '➕', label: 'Yes, add it', example: `Becomes: ${d.now}` },
        { id: 'keep', emoji: '↩️', label: 'No, leave it out', example: `Stays: ${d.was}` },
      ]
    }
    if (d.kind === 'conflict') {
      return [
        { id: 'keep', emoji: '↩️', label: `Keep: ${d.was}`, example: 'What I said before' },
        { id: 'switch', emoji: '✏️', label: `Change to: ${d.now}`, example: 'What I just wrote' },
      ]
    }
    const change = d.questions
      .filter((qid) => byId.get(qid) && answered(byId.get(qid), f) && !(qid === d.key && d.kind === 'implied'))
      .map((qid) => {
        const q = byId.get(qid)
        return { id: `change:${qid}`, emoji: '✏️', label: `Change ${q.changeLabel || qid}`, example: `Now: ${show(q, f)}` }
      })
    return d.kind === 'implied'
      ? [{ id: 'set', emoji: '✅', label: text(d.fixLabel, f), example: 'Fix the other answer' }, ...change]
      : [{ id: 'confirm', emoji: '✅', label: "Yes, that's right", example: 'Keep my answers' }, ...change]
  }

  function applyCheck([id], f) {
    const d = divergences(f)[0]
    if (!d) return {}
    if (d.kind === 'conflict') {
      const rest = (f.conflicts || []).filter((c) => c.questionId !== d.questionId)
      return { ...(id === 'switch' ? d.patch : {}), conflicts: rest.length ? rest : undefined }
    }
    if (id === 'confirm') return { confirmed: [...(f.confirmed || []), d.id] }
    if (id === 'set') return { [d.key]: d.value }
    if (id.startsWith('change:')) return clearPatch(id.slice(7))
    return {}
  }

  const CHECK = { id: 'check', keys: [] }
  const QUESTIONS = [CHECK, ...RAW]

  // ---------- Facts ----------

  /** Coerce untrusted facts (from the LLM, the client or older records) into the known shape. */
  function sanitizeFacts(input) {
    const f = {}
    const src = input && typeof input === 'object' ? input : {}
    for (const k of graph.keys) {
      const v = src[k.id]
      if (k.type === 'list') {
        if (!Array.isArray(v)) continue
        const items = [...new Set(v.filter((x) => k.enum.includes(x)))]
        if (items.length || k.keepEmpty) f[k.id] = items
      } else if (k.type === 'bool') {
        if (typeof v === 'boolean') f[k.id] = v
      } else if (k.type === 'enum') {
        if (k.enum.includes(v)) f[k.id] = v
      } else if (k.type === 'number') {
        const n = Number(v)
        if (v != null && v !== '' && Number.isFinite(n) && n >= (k.min ?? -Infinity) && n < (k.below ?? Infinity)) f[k.id] = n
      } else if (k.type === 'states') {
        if (!Array.isArray(v)) continue
        const s = [...new Set(v.map(matchState).filter(Boolean))]
        if (s.length) f[k.id] = s
      } else if (k.type === 'strings') {
        if (Array.isArray(v)) f[k.id] = v.map((p) => String(p).trim().slice(0, k.maxLength)).filter(Boolean).slice(0, k.maxItems)
      } else if (k.type === 'string') {
        if (typeof v === 'string' && v.trim()) f[k.id] = v.trim().slice(0, k.maxLength)
      }
    }
    legacyInput(src, f)
    if (Array.isArray(src.confirmed)) {
      const c = [...new Set(src.confirmed.filter((id) => rules.some((r) => r.id === id && r.rel === 'unlikely')))]
      if (c.length) f.confirmed = c
    }
    if (Array.isArray(src.implied)) {
      const m = [...new Set(src.implied.filter((k) => rules.some((r) => r.rel === 'implies' && r.key === k)))]
      if (m.length) f.implied = m
    }
    if (Array.isArray(src.conflicts)) {
      const c = src.conflicts
        .filter((x) => x && byId.has(x.questionId) && x.patch && typeof x.patch === 'object')
        .slice(0, 5)
        .map((x) => ({
          questionId: x.questionId,
          patch: Object.fromEntries(Object.entries(x.patch).filter(([k]) => byId.get(x.questionId).keys.includes(k))),
          was: String(x.was || '').slice(0, 120),
          now: String(x.now || '').slice(0, 120),
          ...(x.added ? { added: String(x.added).slice(0, 120) } : {}),
        }))
      if (c.length) f.conflicts = c
    }
    for (const k of graph.keep || []) if (!ev(k.when, f)) delete f[k.key]
    for (const d of graph.derive || []) {
      if (!ev(d.when, f)) continue
      f[d.key] = d.list ? d.list.filter((x) => ev(x.when, f)).map((x) => x.value) : ev(d.bool, f)
    }
    return f
  }

  /** Older records and model output may describe the business in the portal's earlier vocabulary. */
  function legacyInput(src, f) {
    if (!Array.isArray(src.activities) && (Array.isArray(src.kob) || src.importer === true)) {
      const kob = Array.isArray(src.kob) ? src.kob : []
      const a = []
      if (kob.includes('foodService')) a.push('cook')
      if (kob.includes('manufacturer')) a.push('make')
      if (kob.includes('tradeRetailStorageTransport') && !(src.importer === true && kob.length === 1)) a.push('sell')
      if (src.importer === true) a.push('import')
      if (a.length) f.activities = a.filter((x) => listEnums.activities.includes(x))
    }
    if (!f.place) {
      if (src.is_street_vendor === true) f.place = 'street'
      else if (src.govt_airport_seaport_railway === true) f.place = 'hub'
      else if (src.home_based === true) f.place = 'home'
      else if (src.is_street_vendor === false) f.place = 'premises'
    }
  }

  /** Is the question's current answer still consistent with the options the earlier answers allow? */
  function isAnswerValid(q, f) {
    if (!answered(q, f)) return true
    if (q.valid !== undefined) return call(q.valid, f)
    if (isCheck(q)) return true
    const ids = optionsFor(q, f).map((o) => o.id)
    return (valueOf(q, f) || []).every((id) => ids.includes(id))
  }

  const ask = (q, f = {}) => relevant(q, f) && !answered(q, f)
  const nextQuestion = (facts) => QUESTIONS.find((q) => ask(q, facts || {})) || null

  function clearQuestion(facts, questionId) {
    const q = QUESTIONS.find((x) => x.id === questionId)
    const next = { ...facts }
    q?.keys.forEach((k) => delete next[k])
    q?.alsoClears?.forEach((k) => delete next[k])
    if (next.confirmed) {
      next.confirmed = next.confirmed.filter((id) => !rules.find((r) => r.id === id)?.questions.includes(questionId))
      if (!next.confirmed.length) delete next.confirmed
    }
    if (next.conflicts) {
      next.conflicts = next.conflicts.filter((c) => c.questionId !== questionId)
      if (!next.conflicts.length) delete next.conflicts
    }
    return next
  }

  /** Clear answers that earlier answers made impossible (e.g. "street cart" after switching to "make or pack"). */
  function reconcile(facts) {
    let f = applyImplied(facts)
    for (let pass = 0; pass < QUESTIONS.length; pass++) {
      const bad = QUESTIONS.find((q) => relevant(q, f) && !isAnswerValid(q, f))
      if (!bad) break
      f = applyImplied(clearQuestion(f, bad.id))
    }
    return f
  }

  /** Apply a tap answer. Returns the new facts, or throws a user-facing message for an invalid pick. */
  function applyTap(facts, q, { optionIds, states }) {
    if (q.kind === 'states') {
      const picked = sanitizeFacts({ states: Array.isArray(states) ? states : [] }).states || []
      if (!picked.length) throw new Error('Pick a state.')
      if (isMulti(q, facts) && picked.length < 2) throw new Error('Pick at least two states, or change your answer about locations.')
      if (!isMulti(q, facts) && picked.length > 1) throw new Error('Pick one state.')
      return { facts: reconcile({ ...facts, states: picked }), answer: picked.join(', ') }
    }
    const opts = optionsFor(q, facts)
    let ids = [...new Set((Array.isArray(optionIds) ? optionIds : []).filter((o) => opts.some((x) => x.id === o)))]
    if (ids.some((id) => opts.find((o) => o.id === id).exclusive)) ids = ids.filter((id) => opts.find((o) => o.id === id).exclusive).slice(0, 1)
    if (!ids.length || (!isMulti(q, facts) && ids.length !== 1)) throw new Error('Pick an option.')
    const patch = isCheck(q) ? applyCheck(ids, facts) : apply(q, ids, facts)
    return {
      facts: reconcile(sanitizeFacts({ ...facts, ...patch })),
      answer: ids.map((o) => opts.find((x) => x.id === o).label).join(', '),
    }
  }

  const MERGE_SKIP = ['kob', 'importer', 'description', 'implied', 'confirmed', 'conflicts']

  /**
   * Merge an interpreted typed answer ({ choice, facts }) from any interpreter layer.
   * A matched option is applied exactly like a tap. Other facts fill questions not answered yet; when they
   * disagree with an earlier answer they become a conflict the user resolves ("Earlier you said X…").
   * Lists only ever grow (a typed "we also make pickles" adds to the activities rather than replacing them).
   */
  function mergeInterpretation(facts, q, { choice = [], facts: raw = {} } = {}, typed) {
    const extra = { ...raw }
    const rupees = Number(extra.annual_sales_rupees)
    if (Number.isFinite(rupees) && rupees > 0) extra.turnover_crore = rupees / 1e7
    delete extra.annual_sales_rupees
    for (const k of ['activities', 'trade', 'states', 'products']) {
      if (Array.isArray(extra[k]) && Array.isArray(facts[k])) extra[k] = [...new Set([...facts[k], ...extra[k]])]
    }
    const opts = optionsFor(q, facts)
    const ids = (Array.isArray(choice) ? choice : []).filter((c) => opts.some((o) => o.id === c))
    const picked = ids.length && (isMulti(q, facts) || ids.length === 1) ? (isCheck(q) ? applyCheck(ids, facts) : apply(q, ids, facts)) : {}

    const candidate = sanitizeFacts({ ...facts, ...extra })
    const changed = Object.keys(candidate).filter((k) => !MERGE_SKIP.includes(k) && JSON.stringify(candidate[k]) !== JSON.stringify(facts[k]))
    const merged = { ...facts }
    const conflicts = [...(facts.conflicts || [])]
    const byQuestion = new Map()
    for (const k of changed) {
      const owner = RAW.find((x) => x.keys.includes(k))
      if (!owner || owner.id === q.id || !answered(owner, facts) || !relevant(owner, facts)) merged[k] = candidate[k]
      else byQuestion.set(owner, { ...byQuestion.get(owner), [k]: candidate[k] })
    }
    for (const [owner, patch] of byQuestion) {
      const after = sanitizeFacts({ ...facts, ...patch })
      if (show(owner, after) === show(owner, facts) || !isAnswerValid(owner, after)) continue
      const i = conflicts.findIndex((c) => c.questionId === owner.id)
      // A list that only grew is an addition ("we also make pickles"), not a contradiction.
      const grown = Object.entries(patch).every(([k, v]) => Array.isArray(v) && Array.isArray(facts[k]) && facts[k].every((x) => v.includes(x)))
      const added = grown && show(owner, sanitizeFacts({ ...facts, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v.filter((x) => !facts[k].includes(x))])) }))
      const conflict = { questionId: owner.id, patch, was: show(owner, facts), now: show(owner, after), ...(added ? { added } : {}) }
      if (i >= 0) conflicts[i] = conflict
      else conflicts.push(conflict)
    }
    return reconcile(
      sanitizeFacts({
        ...merged,
        ...picked,
        conflicts: conflicts.length ? conflicts : undefined,
        description: facts.description || String(typed || '').trim().slice(0, 500),
      }),
    )
  }

  /** What the host renders for a question. */
  function render(q, f = {}) {
    return {
      id: q.id,
      kind: q.kind || null,
      title: titleFor(q, f),
      hint: hintFor(q, f),
      multi: isMulti(q, f),
      options: optionsFor(q, f),
    }
  }

  /** Summary rows for every answered, relevant question. */
  function summary(f) {
    return RAW.filter((q) => relevant(q, f) && answered(q, f)).map((q) => ({ id: q.id, value: show(q, f) }))
  }

  return {
    graph, ev, QUESTIONS, RAW, CHECK,
    matchState, relevant, answered, isMulti, titleFor, hintFor, optionsFor, show, render, summary,
    divergences, impliedBy, isAnswerValid, nextQuestion, clearQuestion, reconcile, applyTap, sanitizeFacts, mergeInterpretation,
    keySpec,
  }
}
