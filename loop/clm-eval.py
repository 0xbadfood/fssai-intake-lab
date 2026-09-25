"""Evaluate CLM on the FSSAI intake test set (data/fssai/all/test.jsonl), per origin.

Top-1 accuracy: the highest-probability option is one of the gold options (multi-option answers count as
correct if the top option is any of them). Reported for each checkpoint given, plus the encoder-only
ablation (clm-raw). Also the median latency per answer and the accuracy on "none" answers.

Usage (inside the CLM container, encoder at :8090):
  python eval.py --test /clm/data/fssai/all/test.jsonl --model base=/clm/ckpts/CLM_v0.1-8B.pt [--model ft=...] [--out r.json]
"""
import argparse, json, statistics, time
from collections import defaultdict
from clm import Engine
from clm.schema import label_of

ap = argparse.ArgumentParser()
ap.add_argument("--test", required=True)
ap.add_argument("--model", action="append", default=[], help="name=checkpoint.pt")
ap.add_argument("--raw", action="store_true", help="also score the encoder-only ablation")
ap.add_argument("--out", default=None)
a = ap.parse_args()

rows = [json.loads(l) for l in open(a.test) if l.strip()]
models = dict(m.split("=", 1) for m in a.model)
engine = Engine(checkpoint=next(iter(models.values())), models=models)
names = list(models) + (["clm-raw"] if a.raw else [])
report = {}
for name in names:
    per = defaultdict(lambda: [0, 0]); none = [0, 0]; ms = []; misses = []; conf = []
    for r in rows:
        state, questions, gold = json.loads(r["state"]), json.loads(r["questions"]), json.loads(r["gold"])["q"]
        t = time.perf_counter()
        out = engine.answer(state, questions, model=name)
        ms.append((time.perf_counter() - t) * 1000)
        ans = out["answers"]["q"]
        top = label_of(ans)
        ok = top in gold["probabilities"]
        probs = ans.get("probabilities") or {}
        conf.append((max(probs.values()) if probs else 0.0, ok, r["origin"]))
        for key in (r["origin"], "all"):
            per[key][0] += ok; per[key][1] += 1
        if gold["label"] == "none":
            none[0] += ok; none[1] += 1
        if not ok and r["origin"] != "generated-dev":
            misses.append(f'{r["workflow"]}: "{state["The user answered"]}" gold {"+".join(gold["probabilities"])} -> {top}')
    report[name] = {k: f"{v[0]}/{v[1]} ({100 * v[0] / v[1]:.0f}%)" for k, v in per.items()}
    report[name]["none"] = f"{none[0]}/{none[1]}"
    report[name]["median_ms"] = round(statistics.median(ms), 1)
    report[name]["misses_independent"] = misses
    # Accuracy vs coverage: answer only when the top probability reaches the threshold, hand the rest on.
    curve = {}
    for group, keep in (("independent", lambda o: o != "generated-dev"), ("generated-dev", lambda o: o == "generated-dev")):
        pts = [(p, ok) for p, ok, o in conf if keep(o)]
        for th in (0.0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95):
            sel = [ok for p, ok in pts if p >= th]
            curve[f"{group}@{th}"] = f"covers {len(sel)}/{len(pts)} ({100 * len(sel) / max(1, len(pts)):.0f}%), accuracy {100 * sum(sel) / max(1, len(sel)):.0f}%"
    report[name]["coverage"] = curve
    for k, v in curve.items():
        print("  ", k, v)
    print(name, {k: v for k, v in report[name].items() if k != "misses_independent"}, flush=True)
if a.out:
    json.dump(report, open(a.out, "w"), indent=2, ensure_ascii=False)
