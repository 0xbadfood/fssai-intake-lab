#!/usr/bin/env node
// Intake lab CLI.
//   lab check   [--graph FILE]                      validate the graph and walk every path (invariants)
//   lab walk    [--graph FILE] [--parity [DIR]] [--tree] [--merge-every N]
//                                                   walk every path; --parity also steps the portal in lockstep
//   lab ask     [--graph FILE]                      answer the questions interactively (taps by number)
//   lab explain [--graph FILE] '<facts json>'       verdict for a set of facts, with the edges and sources behind it
//   lab cases   [--graph FILE] [CASES.json]         run scenario cases (default tests/cases.v<version>.json)
import path from 'node:path'
import readline from 'node:readline'
import { stdin, stdout } from 'node:process'
import { createEngine, loadGraph, validateGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { portalAdapter, walkAll } from './walk.js'
import { runCases } from './cases.js'
import { readFileSync } from 'node:fs'

const DEFAULT_GRAPH = path.join(LAB_ROOT, 'graph/graph.v1.json')
const DEFAULT_PORTAL = path.resolve(LAB_ROOT, '../fssai-portal')

function parseArgs(argv) {
  const [cmd = 'help', ...rest] = argv
  const opts = { _: [] }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--graph') opts.graph = rest[++i]
    else if (a === '--parity') opts.parity = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : DEFAULT_PORTAL
    else if (a === '--tree') opts.tree = true
    else if (a === '--merge-every') opts.mergeEvery = Number(rest[++i])
    else if (a === '--pick') opts.pick = Number(rest[++i])
    else opts._.push(a)
  }
  return { cmd, opts }
}

/**
 * How many options of a multi-select question the walker combines. v1 walks every subset (as the portal checker
 * does). v2 has large lists of kinds of business, so it walks every pair of activities, every pair of kinds for
 * a single activity, and every single kind when several activities are picked. --pick N raises the limit.
 */
function pickLimit(graph, opts) {
  if (graph.verdict?.model !== 'kob') return null
  const n = opts.pick ?? 2
  return (q, f) => (q.id === 'activity' ? n : (f.activities || []).length > 1 ? n - 1 : n)
}

function load(opts) {
  const file = path.resolve(opts.graph || DEFAULT_GRAPH)
  const graph = loadGraph(file)
  const problems = validateGraph(graph)
  return { file, graph, problems }
}

function report(result, { tree }) {
  console.log(`paths: ${result.paths}   steps: ${result.steps}${result.merges ? `   typed merges compared: ${result.merges}` : ''}`)
  console.log('verdicts:', result.verdicts)
  if (tree) {
    for (const [k, n] of result.tree) if (k.split(' > ').length <= 3) console.log(`${'  '.repeat(k.split(' > ').length - 1)}${k.split(' > ').at(-1)}  (${n})`)
  }
}

function printVerdict(v) {
  const fee = v.fee != null ? `, ₹${v.fee} a year` : ''
  console.log(`\nResult: ${v.licence || v.outcome}${fee}${v.provisional ? '  (likely; an expert can confirm)' : ''}`)
  for (const r of v.reasons) console.log(' -', r)
  for (const h of v.handover || []) console.log(' ! expert:', h)
  for (const t of v.tasks || []) console.log(` + task: ${t.label || t.task}${t.licence ? ` — ${t.licence}, ₹${t.fee} a year` : ''}. ${t.text}`)
  if (v.documents?.length) {
    console.log('Documents:')
    for (const d of v.documents) console.log(`  • ${d.label}`)
  }
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2))
  if (cmd === 'help' || cmd === '--help') {
    console.log('usage: lab check|walk|ask|explain|cases [--graph FILE] [--parity [PORTAL_DIR]] [--tree] [--merge-every N]')
    return 0
  }
  const { file, graph, problems } = load(opts)
  console.log(`graph: ${path.relative(process.cwd(), file) || file} (v${graph.version})`)
  if (problems.length) {
    console.error(`\n${problems.length} graph problem(s):`)
    for (const p of problems) console.error(' -', p)
    if (cmd !== 'explain') return 1
  }
  const E = createEngine(graph)

  if (cmd === 'check' || cmd === 'walk') {
    const portal = cmd === 'walk' && opts.parity ? await portalAdapter(path.resolve(opts.parity)) : null
    if (portal) console.log(`parity against: ${path.resolve(opts.parity)}`)
    const t0 = Date.now()
    const result = walkAll(E, E, { portal, tree: opts.tree, mergeEvery: portal ? opts.mergeEvery ?? 7 : 0, maxPick: pickLimit(graph, opts) })
    report(result, opts)
    console.log(`time: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    let bad = 0
    if (result.failures.length) {
      bad = 1
      console.error(`\n${result.failures.length} path problem(s):`)
      for (const x of result.failures.slice(0, 40)) console.error(' -', x)
    }
    if (portal) {
      if (result.parity.length) {
        bad = 1
        console.error(`\n${result.parity.length} parity difference(s) (first 10):`)
        for (const x of result.parity.slice(0, 10)) console.error(' -', x)
      } else console.log('parity: identical to the portal on every path (questions, facts, verdicts, summaries, sampled typed merges)')
    }
    if (!bad) console.log('all paths OK')
    return bad
  }

  if (cmd === 'cases') {
    const file = path.resolve(opts._[0] || path.join(LAB_ROOT, `tests/cases.v${graph.version}.json`))
    const results = runCases(E, JSON.parse(readFileSync(file, 'utf8')).cases)
    for (const r of results) {
      const v = r.verdict
      console.log(`${r.problems.length ? '✖' : '✔'} ${r.name}  →  ${v.licence || v.outcome}${v.fee != null ? ` ₹${v.fee}` : ''}${v.handover?.length ? ' (+expert)' : ''}`)
      for (const p of r.problems) console.log(`    - ${p}`)
    }
    const bad = results.filter((r) => r.problems.length).length
    console.log(`\n${results.length - bad}/${results.length} cases pass`)
    return bad ? 1 : 0
  }

  if (cmd === 'explain') {
    const facts = E.sanitizeFacts(JSON.parse(opts._[0] || '{}'))
    const v = E.verdict(facts)
    console.log('facts:', JSON.stringify(facts))
    printVerdict(v)
    console.log('\ntrail:')
    for (const id of v.trail) {
      const [what, name] = id.includes(':') ? id.split(':') : ['edge', id]
      const item = what === 'concept' ? graph.concepts.find((c) => c.id === name) : what === 'bands' ? null : graph.edges.find((x) => x.id === id)
      const sources = what === 'bands' ? graph.verdict.bandSources?.[name] || [] : item?.sources || []
      console.log(`  ${id}  [${what === 'edge' ? item.rel : what}, ${item?.status || 'draft'}]`)
      for (const s0 of sources) {
        const s = { ...(graph.defaultSource || {}), ...s0 }
        console.log(`      source ${s.level}: ${s.file}${s.page ? ` p.${s.page}` : ''} — "${s.quote}"`)
      }
      if (!sources.length) console.log('      (no source yet)')
    }
    return 0
  }

  if (cmd === 'ask') {
    // Read lines through the iterator (not rl.question) so piped input works as well as a terminal.
    const rl = readline.createInterface({ input: stdin, terminal: false })
    const lines = rl[Symbol.asyncIterator]()
    const prompt = async (p) => {
      stdout.write(p)
      const { value, done } = await lines.next()
      if (done) throw new Error('input ended')
      if (!stdin.isTTY) stdout.write(`${value}\n`)
      return value
    }
    let f = {}
    try {
      for (;;) {
        const q = E.nextQuestion(f)
        if (!q) break
        const r = E.render(q, f)
        console.log(`\n${r.title}${r.hint ? `\n  (${r.hint})` : ''}`)
        let tap
        if (q.kind === 'states') {
          const line = await prompt(`  state${r.multi ? 's, comma-separated' : ''}: `)
          tap = { states: line.split(',').map((s) => s.trim()).filter(Boolean) }
        } else {
          r.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.emoji} ${o.label} — ${o.example}`))
          const line = await prompt(`  pick${r.multi ? ' (e.g. 1,3)' : ''}: `)
          tap = { optionIds: line.split(/[ ,]+/).filter(Boolean).map((n) => r.options[Number(n) - 1]?.id).filter(Boolean) }
        }
        try {
          f = E.applyTap(f, q, tap).facts
        } catch (e) {
          console.log(`  ! ${e.message}`)
        }
      }
    } catch (e) {
      if (e.message !== 'input ended') throw e
      console.log(`\n(input ended before a verdict)\nfacts so far: ${JSON.stringify(f)}`)
      return 1
    } finally {
      rl.close()
    }
    console.log('\nSummary:')
    for (const row of E.summary(f)) console.log(`  ${row.id}: ${row.value}`)
    printVerdict(E.verdict(f))
    console.log(`\nfacts: ${JSON.stringify(f)}`)
    return 0
  }

  console.error(`unknown command: ${cmd}`)
  return 2
}

process.exitCode = await main()
