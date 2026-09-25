// Views and blind classification, shared by the cache-fill runner (fill.mjs) and the production-cache
// converter (ingest-cache.mjs), so every record is judged by the same prompt.

const ESCAPES = new Set(['unsure', 'none'])

/** A question as a user reaches it: the facts already given decide which options it shows. */
export function viewMaker(E, graph) {
  const concepts = new Map((graph.concepts || []).map((c) => [c.id, c]))
  return (v) => {
    const q = E.QUESTIONS.find((x) => x.id === v.step)
    const facts = E.sanitizeFacts(v.context || {})
    const options = E.optionsFor(q, facts).filter((o) => !ESCAPES.has(o.id)).map((o) => ({ ...o, desc: concepts.get(o.id)?.desc || null }))
    return { ...v, q, facts, title: E.titleFor(q, facts), multi: E.isMulti(q, facts), options, context: contextLine(E, facts) }
  }
}

export const optionList = (options) => options.map((o) => `- ${o.id}: ${o.label} — ${o.example}${o.desc ? ` (${o.desc})` : ''}`).join('\n')

function contextLine(E, facts) {
  const rows = E.summary(facts).map((r) => r.value).filter(Boolean)
  return rows.length ? `What the user already told the chat: ${rows.join('; ')}.\n` : ''
}

export function classifyPrompt(view, text, notes = []) {
  return `${view.context}A user of an FSSAI licensing chat was asked: "${view.title}"

Options:
${optionList(view.options)}
${notes.length ? `\nLabelling rules from the FSSAI expert:\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}
The user answered: """${text}"""

Which option${view.multi ? '(s)' : ''} does the answer mean? Pick only options the answer clearly states or strongly implies${view.multi ? ' (more than one only if the answer describes more than one)' : ''}. If no option fits, or the answer is off-topic or unclear, return an empty list.
Reply as JSON: {"choice": ["<option id>", ...], "confidence": "high|medium|low"}`
}

/** Blind classification: the model sees the question and options, never the intended answer. */
export async function classify(client, view, text, notes = []) {
  const ids = view.options.map((o) => o.id)
  const schema = {
    type: 'object',
    properties: { choice: { type: 'array', items: { type: 'string', enum: ids } }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } },
    required: ['choice', 'confidence'],
  }
  const r = await client([{ role: 'user', content: classifyPrompt(view, text, notes) }], { temperature: 0, maxTokens: 200, schema })
  return { choice: [...new Set((r.choice || []).filter((c) => ids.includes(c)))].sort(), confidence: r.confidence ?? null }
}

export const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x))
