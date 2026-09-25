// Interpretation records (DESIGN.md §4): one JSONL line per interpreted answer, the same shape from every producer.
import { createHash } from 'node:crypto'

const STOP = new Set(
  ('i im i\'m we my our me us a an the is are am was it its of for to in on at and or with from by as so just only also do does ' +
  'have has run runs running own owns sell sells about around approx approximately roughly nearly almost maybe like ' +
  'ji haan hai hain hum mera meri mere main ka ki ke se me mein aur bhi toh to bas kuch ek sir madam please yes yeah ok okay business')
    .split(/\s+/),
)

/**
 * Like the portal's normalizeText, but Unicode-aware: the portal keeps only a-z/0-9, so an answer typed in
 * Devanagari normalises to "" there (and can never be cached). Here letters and digits of any script are kept.
 */
export function normalizeText(text) {
  return String(text || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/₹|\brs\.?|\binr\b|rupees?/g, ' rs ')
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/[^\p{L}\p{M}\p{N}.'\s]/gu, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenSignature(text) {
  const words = normalizeText(text).split(' ').filter((w) => w && !STOP.has(w))
  return [...new Set(words)].sort().join(' ')
}

export const sha = (s) => createHash('sha256').update(s).digest('hex')

export function makeRecord({ step, candidates, graphVersion, knownFacts = {}, text, lang, targets, negatives = [], unknown = false, facts = {}, source, producer, status, review, split }) {
  const text_norm = normalizeText(text)
  const candidates_sig = `g${graphVersion}:${candidates.join(',')}`
  return {
    id: sha([step, candidates_sig, text_norm].join('\n')),
    step, candidates, candidates_sig, known_facts: knownFacts,
    text, text_norm, token_sig: tokenSignature(text), lang,
    targets, negatives: [...new Set(negatives)].filter((n) => !targets.includes(n)), unknown, facts,
    source, producer, graph_version: graphVersion, status, split,
    ...(review ? { review } : {}),
    pii: false,
    created_at: new Date().toISOString(),
  }
}

/** Deterministic train/dev split by text, so a phrasing never lands in both. */
export const splitFor = (textNorm, devShare = 0.1) => (parseInt(sha(textNorm).slice(0, 8), 16) / 0xffffffff < devShare ? 'dev' : 'train')
