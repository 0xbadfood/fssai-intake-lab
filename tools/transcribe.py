#!/usr/bin/env python3
"""Transcribe scanned or screenshot-heavy PDF pages to Markdown with the local Qwen vision model (:7001).

Usage: tools/transcribe.py <pdf> <out.md> [--dpi 150]
Each page is rendered with pdftoppm and sent once. Temperature 0, thinking off. The output records the
source sha256 and model so the text can be cited and reproduced. The transcription is machine-made:
cite it, but check numbers against the page image before an edge is promoted to `expert`.
"""
import argparse, base64, hashlib, json, os, subprocess, sys, tempfile, urllib.request
from pathlib import Path

URL = os.environ.get("QWEN_URL", "http://localhost:7001/v1/chat/completions")
PROMPT = ("Transcribe this page exactly as Markdown. Reproduce tables as Markdown tables, keeping every row, "
          "column header and tick/cross mark. Describe screenshots of forms briefly in [brackets], listing their "
          "field labels and options. Do not summarise or add anything.")


def ask(png, key):
    body = {"model": "qwen3.8-27b", "max_tokens": 8000, "temperature": 0, "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png.read_bytes()).decode()}},
                {"type": "text", "text": PROMPT}]}]}
    req = urllib.request.Request(URL, json.dumps(body).encode(), {"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.load(r)
    c = d["choices"][0]
    if c.get("finish_reason") != "stop":
        raise RuntimeError(f"{png.name}: finish_reason={c.get('finish_reason')}")
    return c["message"]["content"].strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("pdf", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--dpi", type=int, default=150)
    a = p.parse_args()
    key = os.environ.get("VLLM_API_KEY") or sys.exit("VLLM_API_KEY not set")
    sha = hashlib.sha256(a.pdf.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(a.dpi), "-png", str(a.pdf), f"{tmp}/p"], check=True)
        pages = sorted(Path(tmp).glob("p-*.png"))
        parts = [f"<!-- source: {a.pdf.name} sha256:{sha} pages:{len(pages)} model:qwen3.8-27b dpi:{a.dpi} -->"]
        for i, png in enumerate(pages, 1):
            parts.append(f"\n<!-- page {i} -->\n\n{ask(png, key)}")
            print(f"{a.pdf.name}: page {i}/{len(pages)}", file=sys.stderr)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text("\n".join(parts) + "\n")


if __name__ == "__main__":
    main()
