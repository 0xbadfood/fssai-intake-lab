// Intake test page: chat widget talking to the lab test server. Every reply shows how the answer was
// understood, with a "Not what I meant" button; the result asks "Is this right?".
const $ = (s) => document.querySelector(s)
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v
    else if (k === 'text') n.textContent = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else if (v !== false && v != null) n.setAttribute(k, v)
  }
  for (const k of kids) if (k != null) n.append(k)
  return n
}
const store = { get: (k) => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }

let session = null
let turn = null
const questions = new Map() // turnId -> question, for "Not what I meant"
const picked = new Set()
const pickedStates = []

async function call(route, body) {
  const res = await fetch(`api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({ error: 'The server did not answer. Try again.' }))
  if (!res.ok) throw new Error(data.error || 'Something went wrong.')
  return data
}
const scrollDown = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
const showError = (id, msg) => { const e = $(id); e.textContent = msg || ''; e.hidden = !msg }

// ---------- start ----------
$('#code').value = store.get('fssai-test-code') || ''
$('#start').addEventListener('click', start)
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') start() })
$('#restart').addEventListener('click', () => { $('#chat').textContent = ''; questions.clear(); start() })

async function start() {
  const code = $('#code').value.trim()
  if (!code) return showError('#gateError', 'Enter the invite code you were given.')
  $('#start').disabled = true
  try {
    const d = await call('start', { code })
    store.set('fssai-test-code', code)
    session = d.session
    $('#gate').hidden = true
    $('#chat').hidden = false
    $('#restart').hidden = false
    $('#chat').append(el('div', { class: 'bot', text: 'Hi! I will ask a few questions about your food business and tell you which FSSAI registration or licence it needs. Tap an option, or type in your own words.' }))
    show(d.turn)
  } catch (e) {
    showError('#gateError', e.message)
  } finally {
    $('#start').disabled = false
  }
}

// ---------- turns ----------
function show(t) {
  turn = t
  picked.clear()
  pickedStates.length = 0
  showError('#error', '')
  if (t.done) return showVerdict(t)
  const q = t.question
  questions.set(t.turnId, q)
  if (t.clarify) {
    $('#chat').append(el('div', { class: 'bot' },
      `I'm not sure I understood “${t.clarify.text}”. Did you mean one of these?`,
      el('div', { class: 'hint', text: t.clarify.guesses.length ? 'My best guesses are marked. Pick the right one, or type it differently.' : 'Pick the right option, or type it differently.' })))
  } else {
    $('#chat').append(el('div', { class: 'bot' }, q.title, q.hint ? el('div', { class: 'hint', text: q.hint }) : null))
  }
  renderComposer(t)
  scrollDown()
}

function renderComposer(t) {
  const q = t.question
  const guesses = new Set(t.clarify?.guesses || [])
  const box = $('#choices')
  box.textContent = ''
  $('#composer').hidden = false
  $('#stateBox').hidden = !t.states
  $('#typeForm').hidden = !t.typing
  $('#continueRow').hidden = !(q.multi || t.states)
  if (t.states) return renderStates(t)
  const opts = [...q.options].sort((a, b) => (guesses.has(b.id) ? 1 : 0) - (guesses.has(a.id) ? 1 : 0))
  for (const o of opts) {
    const b = el('button', { type: 'button', class: `opt${guesses.has(o.id) ? ' guess' : ''}`, 'aria-pressed': 'false' },
      el('span', { class: 'emoji', text: o.emoji || '•' }), el('span', { class: 'label', text: o.label }), el('span', { class: 'ex', text: o.example || '' }))
    b.addEventListener('click', () => {
      if (!q.multi) return answer({ tap: { optionIds: [o.id] } }, o.label)
      if (o.exclusive) { picked.clear(); picked.add(o.id) } else { picked.delete([...picked].find((id) => q.options.find((x) => x.id === id)?.exclusive)); picked.has(o.id) ? picked.delete(o.id) : picked.add(o.id) }
      box.querySelectorAll('.opt').forEach((x, i) => x.setAttribute('aria-pressed', String(picked.has(opts[i].id))))
    })
    box.append(b)
  }
}

function renderStates(t) {
  const multi = t.question.multi
  const pop = $('#popular')
  pop.textContent = ''
  const sel = $('#stateSelect')
  sel.textContent = ''
  sel.append(el('option', { value: '', text: 'All states and UTs…' }), ...t.states.all.map((s) => el('option', { value: s, text: s })))
  const refresh = () => {
    $('#pickedStates').textContent = pickedStates.length ? `Picked: ${pickedStates.join(', ')}` : ''
    pop.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(pickedStates.includes(c.dataset.state))))
  }
  const toggle = (s) => {
    if (!multi) { answer({ tap: { states: [s] } }, s); return }
    const i = pickedStates.indexOf(s)
    i >= 0 ? pickedStates.splice(i, 1) : pickedStates.push(s)
    refresh()
  }
  for (const s of t.states.popular) pop.append(el('button', { type: 'button', class: 'chip', 'data-state': s, 'aria-pressed': 'false', text: s, onclick: () => toggle(s) }))
  $('#addState').onclick = () => { if (sel.value) toggle(sel.value) }
  $('#continueRow').hidden = !multi
  refresh()
}

$('#continue').addEventListener('click', () => {
  if (turn?.states) return pickedStates.length ? answer({ tap: { states: [...pickedStates] } }, pickedStates.join(', ')) : showError('#error', 'Pick your states first.')
  if (!picked.size) return showError('#error', 'Tap at least one option.')
  const q = turn.question
  answer({ tap: { optionIds: [...picked] } }, [...picked].map((id) => q.options.find((o) => o.id === id)?.label).join(', '))
})
$('#typeForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const text = $('#typed').value.trim()
  if (!text) return
  $('#typed').value = ''
  answer({ text }, text)
})

async function answer(payload, shown) {
  $('#chat').append(el('div', { class: 'user', text: shown }))
  $('#composer').querySelectorAll('button, input').forEach((x) => { x.disabled = true })
  try {
    const d = await call('answer', { session, ...payload })
    if (d.understood) understood(d.understood)
    show(d.turn)
  } catch (e) {
    showError('#error', e.message)
  } finally {
    $('#composer').querySelectorAll('button, input').forEach((x) => { x.disabled = false })
  }
}

const LAYER = { tap: 'You picked', records: 'Matched a known answer', clm: 'Understood by CLM', clarify: 'You picked' }
function understood(u) {
  const q = questions.get(u.turnId)
  const line = el('div', { class: 'understood' },
    el('span', { class: 'badge', text: `${LAYER[u.layer] || u.layer}${u.p != null ? ` · ${Math.round(u.p * 100)}%` : ''}` }),
    el('span', { text: `→ ${u.answer}` }))
  if (u.layer !== 'tap' && q) line.append(el('button', { type: 'button', class: 'linkish', text: 'Not what I meant', onclick: () => fixPanel(line, q, u) }))
  $('#chat').append(line)
}

function fixPanel(after, q, u) {
  if (after.nextSibling?.classList?.contains('fix')) return
  const chosen = new Set()
  const chips = el('div', { class: 'chips' }, ...q.options.map((o) => {
    const c = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', text: o.label })
    c.addEventListener('click', () => { chosen.has(o.id) ? chosen.delete(o.id) : chosen.add(o.id); c.setAttribute('aria-pressed', String(chosen.has(o.id))) })
    return c
  }))
  const note = el('textarea', { placeholder: 'What did you mean? (optional)', maxlength: '500' })
  const panel = el('div', { class: 'fix' }, el('div', { text: 'What did you mean? Pick the right option(s):' }), chips, note)
  const send = el('button', { type: 'button', class: 'primary', text: 'Send correction' })
  send.addEventListener('click', async () => {
    send.disabled = true
    try {
      await call('feedback', { session, turnId: u.turnId, kind: 'turn', rating: 'wrong', correct: [...chosen], note: note.value })
      panel.replaceChildren(el('div', { class: 'thanks', text: 'Thanks, noted. The conversation continues with the earlier answer; use Start again to redo it.' }))
    } catch (e) { send.disabled = false; panel.append(el('p', { class: 'error', text: e.message })) }
  })
  panel.append(send)
  after.after(panel)
}

// ---------- result ----------
function showVerdict(t) {
  $('#composer').hidden = true
  const v = t.verdict
  const title = v.licence || ({ deemed: 'Deemed registered: no FSSAI application needed', notfood: 'Not a food business under the FSS Act', handover: 'An expert needs to look at this' })[v.outcome] || v.outcome
  const card = el('section', { class: 'verdict', 'aria-label': 'Result' },
    el('h2', { text: title }),
    v.fee != null ? el('div', { class: 'fee', text: `Government fee: ₹${v.fee.toLocaleString('en-IN')} a year` }) : null,
    v.provisional ? el('div', { class: 'provisional', text: 'Likely result. These rules are still being checked by an expert.' }) : null,
    v.reasons?.length ? el('ul', {}, ...v.reasons.map((r) => el('li', { text: r }))) : null,
    v.guidance ? el('div', { text: v.guidance }) : null,
    v.handover?.length ? el('div', { class: 'expert' }, el('b', { text: 'An expert will confirm: ' }), v.handover.join(' ')) : null,
    v.tasks?.length ? el('div', {}, el('h3', { text: 'Also needed' }), el('ul', {}, ...v.tasks.map((x) => el('li', { text: `${x.label}${x.licence ? `: ${x.licence}, ₹${x.fee?.toLocaleString('en-IN')} a year` : ''}. ${x.text}` })))) : null,
    v.documents?.length ? el('details', {}, el('summary', { text: `Documents to upload (${v.documents.length})` }), el('ul', {}, ...v.documents.map((d) => el('li', { text: d })))) : null,
    t.summary?.length ? el('details', {}, el('summary', { text: 'Your answers' }), el('ul', {}, ...t.summary.map((s) => el('li', { text: s.value })))) : null,
    rating(t.turnId))
  $('#chat').append(card)
  scrollDown()
}

function rating(turnId) {
  let choice = null
  const note = el('textarea', { placeholder: 'What is wrong or missing? What do you think the answer should be? (optional)', maxlength: '500' })
  const btns = ['right', 'wrong', 'not sure'].map((r) => {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', text: r === 'right' ? 'Yes, looks right' : r === 'wrong' ? 'No, this is wrong' : 'Not sure' })
    b.addEventListener('click', () => { choice = r; btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b))) })
    return b
  })
  const box = el('div', { class: 'rate' }, el('b', { text: 'Is this result right for this business?' }), el('div', { class: 'chips' }, ...btns), note)
  const send = el('button', { type: 'button', class: 'primary', text: 'Send feedback' })
  send.addEventListener('click', async () => {
    if (!choice) return box.append(el('p', { class: 'error', text: 'Pick one of the three first.' }))
    send.disabled = true
    try {
      await call('feedback', { session, turnId, kind: 'verdict', rating: choice, note: note.value })
      box.replaceChildren(el('div', { class: 'thanks', text: 'Thank you. Tap Start again to test another business.' }))
    } catch (e) { send.disabled = false; box.append(el('p', { class: 'error', text: e.message })) }
  })
  box.append(send)
  return box
}
