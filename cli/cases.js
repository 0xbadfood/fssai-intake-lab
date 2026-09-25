// Scenario cases: answer the questions the automaton asks from a case's `answers`, then check the verdict.
// A case fails if the automaton asks a question the case has no answer for, never asks one it has, asks one
// listed in `not_asked`, or the verdict differs from `expect`.

function tapFor(q, answer) {
  if (q.kind === 'states') return { states: answer }
  return { optionIds: Array.isArray(answer) ? answer : [answer] }
}

export function runCase(E, c) {
  const problems = []
  const asked = []
  let f = {}
  for (let step = 0; step < 40; step++) {
    const q = E.nextQuestion(f)
    if (!q) break
    asked.push(q.id)
    if (!(q.id in c.answers)) {
      problems.push(`asked "${q.id}" (${E.titleFor(q, f)}) but the case has no answer for it`)
      break
    }
    try {
      f = E.applyTap(f, q, tapFor(q, c.answers[q.id])).facts
    } catch (e) {
      problems.push(`answer to "${q.id}" rejected: ${e.message}`)
      break
    }
  }
  const v = E.verdict(f)
  const x = c.expect || {}
  for (const id of Object.keys(c.answers)) if (!asked.includes(id)) problems.push(`never asked "${id}"`)
  for (const id of x.not_asked || []) if (asked.includes(id)) problems.push(`asked "${id}", which should not be needed`)
  if ('outcome' in x && v.outcome !== x.outcome) problems.push(`outcome ${v.outcome}, expected ${x.outcome}`)
  if ('licence_id' in x && E.licenceId(v) !== x.licence_id) problems.push(`licence ${E.licenceId(v)}, expected ${x.licence_id}`)
  if ('fee' in x && v.fee !== x.fee) problems.push(`fee ${v.fee}, expected ${x.fee}`)
  if ('handover' in x && !!(v.handover || []).length !== x.handover) problems.push(`handover ${JSON.stringify(v.handover)}, expected ${x.handover ? 'some' : 'none'}`)
  for (const d of x.documents || []) if (!(v.documents || []).some((doc) => doc.id === d)) problems.push(`document "${d}" missing`)
  for (const t of x.tasks || []) if (!(v.tasks || []).some((task) => task.id === t)) problems.push(`task "${t}" missing`)
  return { name: c.name, asked, facts: f, verdict: v, problems }
}

export function runCases(E, cases) {
  return cases.map((c) => runCase(E, c))
}
