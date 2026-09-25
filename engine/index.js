// Engine entry point: a pure module (no DB, no network) that the lab CLI and, later, the portal server load.
import { createAutomaton } from './automaton.js'
import { createVerdict } from './verdict.js'
import { loadGraph, validateGraph } from './graph.js'

export { loadGraph, validateGraph }

export function createEngine(graph) {
  const automaton = createAutomaton(graph)
  const verdict = createVerdict(graph)
  return { ...automaton, ...verdict }
}
