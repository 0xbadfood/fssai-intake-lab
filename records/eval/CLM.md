# CLM experiment (2026-09-25)

**Question:** can CLM (Contrastive-LM/CLM-v0.1-8B: small heads on a frozen Qwen3-8B encoder) match typed answers to options fast enough and accurately enough to sit in front of the LLM?

## Setup
- **Data:** `loop/clm-data.mjs` turns records into CLM "choice" rows.
  - The state is what the user already told the chat plus their answer; the question is the chat's question.
  - The candidates are each option's label, example and description, plus an explicit "None of these".
  - Multi-option answers get split probabilities.
- **Train:** 2,045 generated records (`records/loop/full-1`, split train); fine-tuning holds out 10% of them for validation.
- **Test:** 250 answers:
  - 192 generated dev (same generator as train, labels are model-made);
  - 3 production cache answers;
  - 55 hand-written by Claude (`records/handwritten/claude-v1.jsonl`), a different model family from the generator, labelled by the proposed expert resolutions.
  - **The independent set is the 58 production and hand-written answers.**
- **Where it ran:** a separate container from the lab's image (vLLM 0.27.1), with the Qwen3-8B encoder (bf16, pooling) on the 3090 while `:7001` was stopped.
- **Model selection:** by validation accuracy only; the test set was scored once for the chosen variant.

## Results

| Model | Hand-written | Generated dev | "none" answers | Median latency |
|---|---:|---:|---:|---:|
| Prompted Qwen 27B (local), blind | 55/58 independent (95%) | — (circular: labels come from it) | — | ~2 s |
| Prompted Spark (flash-next), blind | 56/58 independent (97%) | — (circular) | — | ~4 s |
| CLM zero-shot (released checkpoint) | 18/55 (33%) | 67/192 (35%) | 0/21 | 49 ms |
| CLM encoder only (ablation) | 8/55 (15%) | 24/192 (12%) | 12/21 | <1 ms (after embedding) |
| **CLM fine-tuned** (hard labels, warm start; val 84%) | **45/55 (82%)** | **160/192 (83%)** | **21/21** | **~50 ms** |

Variants, by validation accuracy:

| Variant | Validation |
|---|---:|
| Hard labels, warm start (chosen) | 0.84 |
| Soft labels, more epochs | 0.81 |
| Soft-CE loss | 0.76 |
| Soft labels, first run | 0.74 |
| From scratch | 0.69 |
| From scratch + soft-CE | 0.25 |

Training takes under a minute. The chosen head is `~/clm/fssai/runs/v-hard/best_head.pt` (73 MB, sha256 2371c547cfe88d06…), kept out of git.

## Confidence threshold: CLM as the fast first layer

CLM answers only when its top probability reaches the threshold; everything else goes to the LLM.

| Threshold | Independent (58) | Generated dev (192) |
|---|---|---|
| any | 100% handled, 79% correct | 100% handled, 83% correct |
| 0.7 | **66% handled, 100% correct (38/38)** | 70% handled, 91% correct |
| 0.8 | 60% handled, 100% correct | 56% handled, 92% correct |
| 0.9 | 43% handled, 100% correct | 42% handled, 94% correct |

**Caveats:**
- 38/38 is a small sample; the lower bound of its 95% confidence interval is about 91%.
- The dev labels come from the same models that generated the answers, so they are noisy.
- The hand-written set is not real users.

## Where CLM still fails

Short or Hindi-flavoured answers: "resturant", "dukaan", "thela", "paneer, dahi, lassi" → general, "thok vyapari" → storage, "Dubai bhejte hain basmati" → import. Also the boundaries still open with the expert: dabba delivery, school mid-day meals, chyawanprash.

## Conclusion
- CLM alone (about 82%) is not good enough to replace the LLM (about 95%).
- **As a first layer with a threshold of about 0.7–0.8, it answers roughly 60–70% of typed answers in about 50 ms** with no errors in the independent sample; the rest go to the LLM.
- Proposed runtime chain: **rules → reviewed records (cache) → CLM (confident only) → LLM → expert.**

**Next:**
- more real-user test data;
- relabel after the expert's answers and retrain (under a minute);
- add more short, single-word and Hindi phrasings to the loop (the weak spot);
- decide where the encoder runs permanently (it needs about 16 GB of GPU memory).
