#!/usr/bin/env node
// Intake test page: the chat on its own, for real testers and human review. Separate from the portal.
//
// Served at the root of its own host (https://fssaitest.photovault.live/); every path also works under /test.
//   GET  /                     the page (invite code, then the chat)
//   POST /api/start            { code }                          -> { session, turn }
//   POST /api/answer           { session, tap:{optionIds|states} | text } -> { turn }
//   POST /api/feedback         { session, turnId, kind, rating, correct, note } -> { ok }
//
// Typed answers go through: reviewed records (exact / same words) -> CLM (only when confident) -> otherwise
// clarifying taps with CLM's best guesses. Spark classifies every typed answer silently in the background;
// its answer is logged, never shown. Every event is appended to testbed/data/events.jsonl (git-ignored).
// Nothing is submitted anywhere, and no portal code or data is touched.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createEngine, loadGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { classify, viewMaker } from '../loop/classify.mjs'
import { NONE_KEY, clmRequest } from '../loop/clm-format.mjs'
import { loadEndpoints, makeClient } from '../loop/llm.mjs'
import { normalizeText, tokenSignature } from '../loop/records.mjs'

const CFG = JSON.parse(readFileSync(path.join(LAB_ROOT, 'testbed/config.json'), 'utf8'))
const INVITES = existsSync(path.join(LAB_ROOT, CFG.invites)) ? JSON.parse(readFileSync(path.join(LAB_ROOT, CFG.invites), 'utf8')).codes : {}
const DATA = path.join(LAB_ROOT, 'testbed/data')
mkdirSync(DATA, { recursive: true })
const PUBLIC = path.join(LAB_ROOT, 'testbed/public')

const graph = loadGraph(path.join(LAB_ROOT, CFG.graph))
const E = createEngine(graph)
const makeView = viewMaker(E, graph)
const spark = CFG.silentReviewer ? makeClient(loadEndpoints(path.join(LAB_ROOT, 'loop/endpoints.json')).reviewer, {}) : null
const TEXT_STEPS = new Set(CFG.textSteps) // questions CLM was trained on; others are taps only

// ---------- reviewed records: exact text or same words, for the step ----------
const recordIndex = new Map()
for (const file of CFG.records) {
  for (const line of readFileSync(path.join(LAB_ROOT, file), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line)
    if (r.status !== 'model-reviewed' || r.split === 'test') continue
    for (const k of [`${r.step}|t|${r.text_norm}`, `${r.step}|s|${r.token_sig}`]) if (!recordIndex.has(k)) recordIndex.set(k, r)
  }
}
console.error(`records indexed: ${recordIndex.size}`)

// ---------- personal details ----------
const PII = [/\b[6-9]\d{9}\b/g, /[\w.+-]+@[\w-]+\.[\w.]+/g, /\b\d{4}\s?\d{4}\s?\d{4}\b/g, /\b[A-Z]{5}\d{4}[A-Z]\b/gi]
const redact = (t) => PII.reduce((s, re) => s.replace(re, '[redacted]'), String(t || '')).slice(0, 500)

// ---------- sessions ----------
const sessions = new Map()
const log = (event) => appendFileSync(path.join(DATA, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n')

/** Render the current question. A question keeps one turn id for its clarification, answer and feedback. */
function turnFor(s, { again = false } = {}) {
  const q = E.nextQuestion(s.facts)
  const turnId = again && s.turnId ? s.turnId : `${s.id}:${s.turns++}`
  s.turnId = turnId
  if (!q) {
    const v = E.verdict(s.facts)
    const t = { turnId, done: true, summary: E.summary(s.facts), verdict: {
      outcome: v.outcome, licence: v.licence, fee: v.fee, reasons: v.reasons, handover: v.handover || [], tasks: v.tasks || [],
      documents: (v.documents || []).map((d) => d.label), provisional: v.provisional, guidance: v.guidance || null } }
    log({ type: 'verdict', session: s.id, tester: s.tester, turnId, facts: s.facts, verdict: t.verdict })
    return t
  }
  const r = E.render(q, s.facts)
  return {
    turnId, done: false, question: { id: q.id, kind: r.kind, title: r.title, hint: r.hint, multi: r.multi, options: r.options },
    states: q.kind === 'states' ? { all: graph.enums.states, popular: graph.enums.popularStates } : null,
    typing: TEXT_STEPS.has(q.id),
  }
}

async function clmScores(view, text) {
  const { state, questions } = clmRequest(E, view, text)
  const t0 = Date.now()
  const res = await fetch(`${CFG.clmUrl}/v1/systemone`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, questions, model: CFG.clmModel }), signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`CLM ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const out = await res.json()
  const probs = out.answers.q.probabilities || {}
  const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1])
  return { ranked, ms: Date.now() - t0 }
}

/** Interpret typed text for the current question. -> { choice?, clarify?, layer, detail } */
async function interpret(s, q, rawText) {
  const text = redact(rawText)
  const view = makeView({ step: q.id, context: s.facts })
  const ids = view.options.map((o) => o.id)
  const escape = E.optionsFor(q, s.facts).find((o) => o.exclusive)?.id || null // "none" / "unsure", if the question has one

  // 1. reviewed records
  const rec = recordIndex.get(`${q.id}|t|${normalizeText(text)}`) || recordIndex.get(`${q.id}|s|${tokenSignature(text)}`)
  if (rec && rec.targets.every((t) => ids.includes(t))) {
    const choice = rec.targets.length ? rec.targets : escape ? [escape] : null
    if (choice) return { choice, layer: 'records', detail: { record: rec.id.slice(0, 12), text: rec.text } }
  }

  // 2. CLM, only when confident
  let clm = null
  try {
    clm = await clmScores(view, text)
  } catch (e) {
    log({ type: 'error', where: 'clm', session: s.id, message: e.message })
  }
  if (clm) {
    const [topId, topP] = clm.ranked[0]
    if (topP >= CFG.clmThreshold) {
      if (topId !== NONE_KEY) return { choice: [topId], layer: 'clm', detail: { p: +topP.toFixed(3), ms: clm.ms, ranked: clm.ranked.slice(0, 4) } }
      if (escape) return { choice: [escape], layer: 'clm', detail: { p: +topP.toFixed(3), ms: clm.ms, ranked: clm.ranked.slice(0, 4), none: true } }
    }
  }
  // 3. clarifying taps: CLM's best guesses first, then every other option
  const guesses = clm ? clm.ranked.map(([id]) => id).filter((id) => ids.includes(id)).slice(0, 3) : []
  return { clarify: { guesses, text }, layer: 'clarify', detail: clm ? { ranked: clm.ranked.slice(0, 4), ms: clm.ms } : { clm: 'unavailable' } }
}

function silentReview(s, q, rawText, turnId) {
  if (!spark) return
  const view = makeView({ step: q.id, context: s.facts })
  const t0 = Date.now()
  classify(spark, view, redact(rawText))
    .then((c) => log({ type: 'silent-review', session: s.id, turnId, step: q.id, text: redact(rawText), model: 'spark', choice: c.choice, confidence: c.confidence, ms: Date.now() - t0 }))
    .catch((e) => log({ type: 'error', where: 'silent-review', session: s.id, message: e.message }))
}

// ---------- HTTP ----------
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
const hits = new Map()
const limited = (ip) => {
  const now = Date.now()
  const h = (hits.get(ip) || []).filter((t) => now - t < 60000)
  h.push(now)
  hits.set(ip, h)
  return h.length > CFG.ratePerMinute
}
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { ...HEADERS, 'Content-Type': type })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}
const readBody = (req) => new Promise((resolve, reject) => {
  let n = 0
  const chunks = []
  req.on('data', (c) => { n += c.length; if (n > 20000) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
  req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch { reject(new Error('bad json')) } })
})

async function api(req, res, route) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress
  if (limited(ip)) return send(res, 429, { error: 'Too many requests. Wait a minute and try again.' })
  const body = await readBody(req).catch(() => null)
  if (!body) return send(res, 400, { error: 'Bad request.' })

  if (route === 'start') {
    const tester = INVITES[String(body.code || '').trim()]
    if (!tester) return send(res, 403, { error: 'That invite code is not valid.' })
    const s = { id: randomBytes(8).toString('hex'), tester, facts: {}, turns: 0, pending: null, created: Date.now() }
    sessions.set(s.id, s)
    log({ type: 'start', session: s.id, tester, ua: String(req.headers['user-agent'] || '').slice(0, 120), graph: graph.version, threshold: CFG.clmThreshold })
    return send(res, 200, { session: s.id, turn: turnFor(s) })
  }

  const s = sessions.get(body.session)
  if (!s) return send(res, 410, { error: 'This test session has expired. Start again.' })

  if (route === 'answer') {
    const q = E.nextQuestion(s.facts)
    if (!q) return send(res, 409, { error: 'This conversation is finished. Start again to test another business.' })
    const turnId = s.turnId
    let tap = body.tap
    let meta = { layer: 'tap' }
    if (typeof body.text === 'string' && body.text.trim()) {
      if (!TEXT_STEPS.has(q.id)) return send(res, 400, { error: 'Please pick an option for this question.' })
      const it = await interpret(s, q, body.text)
      silentReview(s, q, body.text, turnId)
      log({ type: 'typed', session: s.id, tester: s.tester, turnId, step: q.id, text: redact(body.text), layer: it.layer, choice: it.choice || null, detail: it.detail })
      if (it.clarify) return send(res, 200, { turn: { ...turnFor(s, { again: true }), clarify: it.clarify } })
      tap = { optionIds: it.choice }
      meta = { layer: it.layer, detail: it.detail, text: redact(body.text) }
    }
    try {
      const out = E.applyTap(s.facts, q, tap || {})
      s.facts = out.facts
      log({ type: 'answer', session: s.id, tester: s.tester, turnId, step: q.id, answer: out.answer, ...meta })
      const next = turnFor(s)
      return send(res, 200, { understood: { step: q.id, answer: out.answer, layer: meta.layer, p: meta.detail?.p ?? null, turnId }, turn: next })
    } catch (e) {
      return send(res, 400, { error: e.message })
    }
  }

  if (route === 'feedback') {
    log({ type: 'feedback', session: s.id, tester: s.tester, turnId: String(body.turnId || ''), kind: String(body.kind || ''),
      rating: String(body.rating || ''), correct: Array.isArray(body.correct) ? body.correct.slice(0, 5).map(String) : null, note: redact(body.note) })
    return send(res, 200, { ok: true })
  }
  return send(res, 404, { error: 'Not found.' })
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    // Same routes at the root and under /test.
    const p = (url.pathname.replace(/^\/test(?=\/|$)/, '') || '/').replace(/(.)\/+$/, '$1')
    if (req.method === 'POST' && p.startsWith('/api/')) return await api(req, res, p.slice('/api/'.length))
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' })
    if (p === '/') return send(res, 200, readFileSync(path.join(PUBLIC, 'index.html')), TYPES['.html'])
    const file = p.slice(1)
    if (/^[\w.-]+$/.test(file) && readdirSync(PUBLIC).includes(file)) return send(res, 200, readFileSync(path.join(PUBLIC, file)), TYPES[path.extname(file)] || 'application/octet-stream')
    return send(res, 404, 'Not found', 'text/plain')
  } catch (e) {
    log({ type: 'error', where: 'http', message: e.message })
    return send(res, 500, { error: 'Something went wrong on our side.' })
  }
})
// Drop sessions idle for a day.
setInterval(() => { for (const [id, s] of sessions) if (Date.now() - s.created > 86400000) sessions.delete(id) }, 3600000).unref()
server.listen(CFG.port, CFG.host, () => console.error(`intake test page on http://${CFG.host}:${CFG.port}/`))
