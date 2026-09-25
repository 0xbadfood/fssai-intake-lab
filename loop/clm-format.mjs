// The exact text CLM sees for one typed answer, shared by the training-data builder (clm-data.mjs) and the
// live test page (testbed/), so the model is always asked in the format it was trained on.

export const NONE_KEY = 'none'
export const NONE_TEXT = 'None of these: the answer does not describe any of the options above, is not about a food business, or is off-topic.'

/** -> { state, questions } for CLM's /v1/systemone (and the "choice" training rows). */
export function clmRequest(E, view, text) {
  const criteria = Object.fromEntries(view.options.map((o) => [o.id, `${o.label} — ${o.example}${o.desc ? ` (${o.desc})` : ''}`]))
  criteria[NONE_KEY] = NONE_TEXT
  const known = E.summary(view.facts).map((x) => x.value).filter(Boolean)
  return {
    state: { ...(known.length ? { 'Already told the chat': known.join('; ') } : {}), 'The user answered': text },
    questions: { q: { type: 'choice', instructions: view.title, criteria } },
  }
}
