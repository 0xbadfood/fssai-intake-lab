// Engine entry point: a pure module (no DB, no network) that the lab CLI and, later, the portal server load.
import { createAutomaton } from './automaton.js'
import { createVerdict } from './verdict.js'
import { loadGraph, validateGraph } from './graph.js'

export { loadGraph, validateGraph }

export function createEngine(graph) {
  const verdict = createVerdict(graph)
  // { needs: key } in a question's `relevant`: ask it only when the verdict depends on that fact.
  const needs = (key, f) => !!verdict.dependsOn?.(f, key)
  const automaton = createAutomaton(graph, { needs })
  return { ...automaton, ...verdict }
}
