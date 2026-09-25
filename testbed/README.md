# Intake test page

**https://fssaitest.photovault.live/** — the chat widget on its own, for testers and human review. Separate from the portal: no portal code, build or data is touched, and nothing is submitted to FSSAI.

## What it does
- It runs the graph v2 conversation. Taps work everywhere; typed answers work on the activity, kind of business, place and online questions.
- Typed answers go through:
  1. reviewed records (exact text or the same words);
  2. **CLM**, only when it is at least 80% confident (`clmThreshold`);
  3. otherwise **clarifying taps**, with CLM's best guesses first.
- **Spark classifies every typed answer silently.** Its answer is logged, never shown.
- Every reply shows how it was understood, with **Not what I meant**; the result card asks **Is this right?**
- Phone numbers, emails, Aadhaar- and PAN-like strings are redacted before logging and before Spark sees them.
- Rate limit 60 requests a minute per IP; `noindex`; strict CSP.

## Access
Invite codes are in `testbed/invites.json` (git-ignored), one per tester label. Remove a line to revoke a code, then restart the server.

## Running
Traffic path: Caddy on 10.8.0.1 → **10.8.0.2:8340** (VPN only) → `testbed/server.mjs`.

CLM runs in the `clm-work` container on the 3090. The lab's `:7001` Qwen must be stopped: they cannot share the GPU.

```bash
sudo docker stop qwen-vllm-single-1          # free the GPU
sudo docker start clm-work
sudo docker exec -d clm-work bash -c 'cd /clm && exec /app/venv/bin/vllm serve Qwen/Qwen3-8B --served-model-name qwen3-8b --runner pooling --enforce-eager --enable-prefix-caching --max-model-len 2048 --gpu-memory-utilization 0.85 --max-num-seqs 32 --host 127.0.0.1 --port 8090 > /clm/encoder.log 2>&1'
# wait until curl -s http://127.0.0.1:8090/v1/models answers (1-10 min), then:
sudo docker exec -d clm-work bash -c 'exec /app/venv/bin/clm-serve --host 127.0.0.1 --port 8700 --ckpt /clm/fssai/fssai-v-hard.pt --model fssai-v-hard=/clm/fssai/fssai-v-hard.pt --no-ui --no-download > /clm/clm-serve.log 2>&1'
cd ~/fssai-intake-lab && mkdir -p testbed/data && setsid nohup node testbed/server.mjs >> testbed/data/server.log 2>&1 < /dev/null &
```

Restart the page server: `kill $(ss -ltnp | grep ':8340' | grep -o 'pid=[0-9]*' | cut -d= -f2)` and run the last line again.

## Review
- `node testbed/report.mjs [--since 2026-09-26]`:
  - how typed answers were handled;
  - CLM vs Spark agreement;
  - every correction and every result rated wrong or unsure.
- The raw log is `testbed/data/events.jsonl`.
- Corrections become human-labelled test records for the next expert review.
