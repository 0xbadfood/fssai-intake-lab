#!/usr/bin/env bash
# Start CLM for the test page (see README "Running"), safely and idempotently:
#   1. CLM already answering on :8700 -> nothing to do.
#   2. GPU busy (the lab's :7001 Qwen or anything else) -> say what holds it and stop. Never kills it unless
#      --stop-qwen is given, which stops only the qwen-vllm-single-1 container.
#   3. Start the clm-work container, then the encoder (:8090) unless it is already running; poll until it answers.
#   4. Start clm-serve (:8700) unless it is already running; poll until it answers, then classify one test answer.
# Usage: testbed/clm-up.sh [--stop-qwen] [--status]
set -uo pipefail

CONTAINER=clm-work
QWEN=qwen-vllm-single-1
ENC_URL=http://127.0.0.1:8090/v1/models
# VPN address, not localhost: the portal on deploy (10.8.0.7) calls CLM here.
CLM_URL=http://10.8.0.2:8700
FREE_MIB=21000          # the encoder asks for 85% of the 3090 (~20.9 GB)
ENC_WAIT=900            # seconds; first load can take ~10 min
CLM_WAIT=180

say() { printf '[clm-up] %s\n' "$*"; }
up() { [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$1")" != 000 ]; }
inside() { sudo -n docker exec "$CONTAINER" "$@"; }
running() { inside pgrep -f "$1" >/dev/null 2>&1; }

smoke() {
  curl -s -m 20 "$CLM_URL/v1/systemone" -H 'content-type: application/json' -d '{"model":"fssai-v-hard",
    "state":{"The user answered":"we run a small dhaba on the highway"},
    "questions":{"q":{"type":"choice","instructions":"What does your business do with food?","criteria":{
      "cook":"Cook & serve — Restaurant, café, hotel, caterer, canteen, tea stall, tiffin service",
      "make":"Make or pack — Bakery, pickles, namkeen, dairy",
      "none":"None of these: not about a food business"}}}}' |
    python3 -c 'import json,sys; a=json.load(sys.stdin)["answers"]["q"]; print("test answer ->", a["choice"], round(a["confidence"], 2))'
}

status() {
  up "$ENC_URL" && say "encoder :8090 up" || say "encoder :8090 down"
  up "$CLM_URL/" && say "CLM :8700 up" || say "CLM :8700 down"
  ss -ltn | grep -q ':7001 ' && say "lab Qwen :7001 is running"
  nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | sed 's/^/[clm-up] GPU /'
}

STOP_QWEN=0
for a in "$@"; do
  case "$a" in
    --stop-qwen) STOP_QWEN=1 ;;
    --status) status; exit 0 ;;
    *) echo "usage: $0 [--stop-qwen] [--status]"; exit 2 ;;
  esac
done

sudo -n docker ps >/dev/null || { say "needs passwordless sudo for docker (or run it in a terminal: sudo -v first)"; exit 1; }

# 1. Already up?
if up "$CLM_URL/"; then say "CLM already answering on :8700"; smoke; exit 0; fi

# 2. GPU free? (skip the check when our own encoder is already loaded)
if ! { sudo -n docker ps -q -f name="^$CONTAINER\$" | grep -q . && running 'vllm serve'; }; then
  if [ "$STOP_QWEN" = 1 ] && sudo -n docker ps -q -f name="^$QWEN\$" | grep -q .; then
    say "stopping $QWEN (lab Qwen :7001)"; sudo -n docker stop "$QWEN" >/dev/null || exit 1; sleep 5
  fi
  used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1)
  total=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
  if [ $((total - used)) -lt "$FREE_MIB" ]; then
    say "GPU busy: ${used}/${total} MiB used; the encoder needs ~${FREE_MIB} MiB free. Held by:"
    nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | sed 's/^/    /'
    ss -ltn | grep -q ':7001 ' && say "that is likely the lab Qwen on :7001: rerun with --stop-qwen to stop it"
    exit 1
  fi
fi

# 3. Container + encoder
sudo -n docker start "$CONTAINER" >/dev/null || exit 1
if up "$ENC_URL"; then say "encoder already up"
else
  if running 'vllm serve'; then say "encoder already starting, waiting for it"
  else
    say "starting encoder (Qwen3-8B pooling) on :8090"
    sudo -n docker exec -d "$CONTAINER" bash -c 'cd /clm && exec /app/venv/bin/vllm serve Qwen/Qwen3-8B --served-model-name qwen3-8b --runner pooling --enforce-eager --enable-prefix-caching --max-model-len 2048 --gpu-memory-utilization 0.85 --max-num-seqs 32 --host 127.0.0.1 --port 8090 > /clm/encoder.log 2>&1'
    sleep 5
  fi
  for ((t = 0; t < ENC_WAIT; t += 10)); do
    up "$ENC_URL" && break
    if ! running 'vllm serve'; then say "encoder exited; last log lines:"; inside tail -20 /clm/encoder.log; exit 1; fi
    ((t % 60 == 0)) && say "waiting for encoder... ${t}s"
    sleep 10
  done
  up "$ENC_URL" || { say "encoder not up after ${ENC_WAIT}s; see /clm/encoder.log in $CONTAINER"; exit 1; }
  say "encoder up"
fi

# 4. clm-serve
if ! running 'clm-serve'; then
  say "starting clm-serve on :8700"
  sudo -n docker exec -d "$CONTAINER" bash -c 'exec /app/venv/bin/clm-serve --host 10.8.0.2 --port 8700 --ckpt /clm/fssai/fssai-v-hard.pt --model fssai-v-hard=/clm/fssai/fssai-v-hard.pt --no-ui --no-download > /clm/clm-serve.log 2>&1'
  sleep 2
fi
for ((t = 0; t < CLM_WAIT; t += 3)); do
  up "$CLM_URL/" && break
  if ! running 'clm-serve'; then say "clm-serve exited; last log lines:"; inside tail -20 /clm/clm-serve.log; exit 1; fi
  sleep 3
done
up "$CLM_URL/" || { say "CLM not up after ${CLM_WAIT}s; see /clm/clm-serve.log in $CONTAINER"; exit 1; }
say "CLM up on :8700 (the test page picks it up without a restart)"
smoke
