// Minimal OpenAI-compatible JSON chat client for the loop: JSON mode, thinking off, retries, usage accounting.
import { readFileSync } from 'node:fs'

const FORBIDDEN_HOSTS = ['10.8.0.5'] // production document checker: never used by the lab

export function loadEndpoints(file) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  for (const [role, ep] of Object.entries(cfg)) {
    if (!ep?.url) continue
    if (FORBIDDEN_HOSTS.some((h) => ep.url.includes(h))) throw new Error(`endpoint "${role}" points at a forbidden host (${ep.url})`)
  }
  return cfg
}

export function makeClient(ep, stats = {}) {
  const key = ep.keyEnv ? process.env[ep.keyEnv] : 'none'
  if (ep.keyEnv && !key) throw new Error(`${ep.keyEnv} is not set`)
  let active = 0
  const queue = []
  const slot = () => new Promise((resolve) => (active < (ep.concurrency || 2) ? (active++, resolve()) : queue.push(resolve)))
  const release = () => (queue.length ? queue.shift()() : active--)
  const s = (stats[ep.model] ||= { calls: 0, failures: 0, prompt_tokens: 0, completion_tokens: 0, seconds: 0 })

  return async function chatJson(messages, { temperature = 0, maxTokens = 1500, seed, schema } = {}) {
    await slot()
    try {
      for (let attempt = 1; ; attempt++) {
        const t0 = Date.now()
        try {
          const res = await fetch(`${ep.url}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            // A retry changes the sampling: at temperature 0 the same request would fail the same way
            // (llama.cpp's JSON mode sometimes pads with whitespace until max_tokens).
            body: JSON.stringify({
              model: ep.model, messages, temperature: attempt === 1 ? temperature : Math.min(1, temperature + 0.3 * (attempt - 1)),
              max_tokens: attempt === 1 ? maxTokens : maxTokens * 2, seed: seed ?? (attempt === 1 ? undefined : 1000 + attempt),
              // A JSON schema is enforced by grammar (llama.cpp, vLLM); plain JSON mode is only a hint that Spark sometimes ignores.
              response_format: schema ? { type: 'json_schema', json_schema: { name: 'reply', schema } } : { type: 'json_object' },
              chat_template_kwargs: { enable_thinking: false },
            }),
            signal: AbortSignal.timeout(300000),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
          const d = await res.json()
          s.calls++
          s.seconds += (Date.now() - t0) / 1000
          s.prompt_tokens += d.usage?.prompt_tokens || 0
          s.completion_tokens += d.usage?.completion_tokens || 0
          const choice = d.choices?.[0]
          if (choice?.finish_reason === 'length') throw new Error('output truncated (max_tokens)')
          return JSON.parse(choice.message.content)
        } catch (e) {
          s.failures++
          if (attempt >= 3) throw e
          await new Promise((r) => setTimeout(r, 1500 * attempt))
        }
      }
    } finally {
      release()
    }
  }
}
