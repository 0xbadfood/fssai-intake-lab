#!/usr/bin/env node
// Summarise the test page's event log (testbed/data/events.jsonl) for human review:
// how typed answers were handled (records / CLM / clarify), CLM vs Spark (silent) agreement, where testers said
// "not what I meant", and how they rated the results. Usage: node testbed/report.mjs [--since 2026-09-25]
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LAB_ROOT } from '../engine/graph.js'

const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : ''
const ev = readFileSync(path.join(LAB_ROOT, 'testbed/data/events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.ts >= since)
const by = (t) => ev.filter((e) => e.type === t)
const count = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {})
const sessions = new Set(by('start').map((e) => e.session))
const typed = by('typed')
// A question can get several typed attempts (after a clarification): match Spark's answer by turn and text.
const silent = new Map(by('silent-review').map((e) => [`${e.turnId}|${e.text}`, e]))
const sk = (e) => `${e.turnId}|${e.text}`
const answers = new Map(by('answer').map((e) => [e.turnId, e]))
const fb = by('feedback')

console.log(`# Test page report${since ? ` since ${since}` : ''}\n`)
console.log(`Sessions: ${sessions.size} (testers: ${JSON.stringify(count(by('start'), (e) => e.tester))}); results reached: ${by('verdict').length}\n`)
console.log(`## Typed answers: ${typed.length}`)
console.log(`Handled by: ${JSON.stringify(count(typed, (e) => e.layer))}`)
const clm = typed.filter((e) => e.layer === 'clm')
const cmp = clm.filter((e) => silent.has(sk(e)))
const agree = cmp.filter((e) => JSON.stringify([...(silent.get(sk(e)).choice || [])].sort()) === JSON.stringify([...(e.choice || [])].sort()))
console.log(`CLM answers that Spark (silent) agrees with: ${agree.length}/${cmp.length}`)
for (const e of cmp.filter((x) => !agree.includes(x))) console.log(`  - ${e.step}: "${e.text}" CLM ${e.choice?.join('+')} (${e.detail?.p}) vs Spark ${silent.get(sk(e)).choice?.join('+') || 'none'}`)
console.log(`\nClarified (CLM not confident), then answered as:`)
for (const e of typed.filter((x) => x.layer === 'clarify')) {
  const a = answers.get(e.turnId)
  console.log(`  - ${e.step}: "${e.text}" guesses ${e.detail?.ranked?.map(([k, p]) => `${k} ${p.toFixed(2)}`).join(', ')} | Spark ${silent.get(sk(e))?.choice?.join('+') || '?'} | user tapped: ${a?.answer ?? '(left)'}`)
}
console.log(`\n## "Not what I meant": ${fb.filter((f) => f.kind === 'turn').length}`)
for (const f of fb.filter((x) => x.kind === 'turn')) {
  const t = typed.find((e) => e.turnId === f.turnId)
  console.log(`  - ${t ? `${t.step}: "${t.text}" → ${t.choice?.join('+')} (${t.layer})` : f.turnId} | should be: ${f.correct?.join('+') || '—'} | ${f.note || ''} [${f.tester}]`)
}
console.log(`\n## Result ratings: ${JSON.stringify(count(fb.filter((f) => f.kind === 'verdict'), (f) => f.rating))}`)
for (const f of fb.filter((x) => x.kind === 'verdict' && x.rating !== 'right')) {
  const v = by('verdict').find((e) => e.turnId === f.turnId)
  console.log(`  - ${f.rating}: ${v?.verdict?.licence || v?.verdict?.outcome} | business: ${JSON.stringify(v?.facts?.business || [])} | ${f.note || ''} [${f.tester}]`)
}
