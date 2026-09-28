#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = [
#   "torch>=2.4",
#   "transformers>=4.51",
#   "sentencepiece>=0.2",
#   "protobuf>=5",
# ]
# ///
"""Secrets Sentinel line classifier for ompx sessions on the tailnet.

Serves hypn05/secrets-sentinel (DeBERTa-v3-base, fp16 on CUDA when available,
fp32 on CPU otherwise) over HTTP so every ompx session can ask "does this line
hold a hardcoded secret?" without loading the model itself. Sessions call it
through `secrets.sentinelUrl` (default http://codemc:8795) and fall back to
regex-only detection when it is unreachable.

API
  GET  /health        -> {"ok": true, "model": "..."}
  POST /v1/classify   {"lines": ["..."]} -> {"scores": [p_secret, ...]}

Run
  HF_HOME=/data/secrets-sentinel/hf UV_CACHE_DIR=/data/secrets-sentinel/uv-cache \
    uv run --script server.py --host 0.0.0.0 --port 8795

systemd --user unit (~/.config/systemd/user/secrets-sentinel.service):
  [Unit]
  Description=secrets-sentinel - secret line classifier for tailnet ompx sessions
  After=network.target tailscaled.service
  [Service]
  Type=simple
  ExecStart=/usr/bin/uv run --script <repo>/packages/coding-agent/scripts/secrets-sentinel/server.py --host 0.0.0.0 --port 8795
  Environment=HF_HOME=/data/secrets-sentinel/hf
  Environment=UV_CACHE_DIR=/data/secrets-sentinel/uv-cache
  Restart=always
  RestartSec=2
  MemoryMax=4G
  [Install]
  WantedBy=default.target
"""

from __future__ import annotations

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_ID = "hypn05/secrets-sentinel"
MAX_LINES = 512
MAX_LINE_CHARS = 2000
MAX_TOKENS = 128
MAX_REQUEST_BYTES = 4 * 1024 * 1024
BATCH_SIZE = 64


class Classifier:
    def __init__(self) -> None:
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, use_fast=True)
        self.model = (
            AutoModelForSequenceClassification.from_pretrained(
                MODEL_ID, dtype=torch.float16 if self.device == "cuda" else torch.float32
            )
            .to(self.device)
            .eval()
        )
        self.lock = threading.Lock()

    def scores(self, lines: list[str]) -> list[float]:
        out = [0.0] * len(lines)
        # Length-sorted batches keep padding (and therefore compute) low.
        order = sorted(range(len(lines)), key=lambda i: len(lines[i]))
        for start in range(0, len(order), BATCH_SIZE):
            idx = order[start : start + BATCH_SIZE]
            encoded = self.tokenizer(
                [lines[i][:MAX_LINE_CHARS] for i in idx],
                padding=True,
                truncation=True,
                max_length=MAX_TOKENS,
                return_tensors="pt",
            ).to(self.device)
            with self.lock, torch.inference_mode():
                probs = torch.softmax(self.model(**encoded).logits.float(), dim=1)[:, 1]
            for i, p in zip(idx, probs.cpu().tolist()):
                out[i] = float(p)
        return out


def make_handler(classifier: Classifier) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._send(200, {"ok": True, "model": MODEL_ID})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/v1/classify":
                self._send(404, {"error": "not found"})
                return
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > MAX_REQUEST_BYTES:
                self._send(413 if length > 0 else 400, {"error": f"body must be 1-{MAX_REQUEST_BYTES} bytes"})
                return
            try:
                body = json.loads(self.rfile.read(length))
            except ValueError:
                self._send(400, {"error": "body must be JSON"})
                return
            lines = body.get("lines") if isinstance(body, dict) else None
            if (
                not isinstance(lines, list)
                or not 1 <= len(lines) <= MAX_LINES
                or not all(isinstance(line, str) for line in lines)
            ):
                self._send(400, {"error": f"lines must be an array of 1-{MAX_LINES} strings"})
                return
            self._send(200, {"scores": classifier.scores(lines)})

        def log_message(self, format: str, *args: object) -> None:  # quiet access log
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8795)
    args = parser.parse_args()
    classifier = Classifier()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(classifier))
    print(f"secrets-sentinel listening on http://{args.host}:{args.port} ({MODEL_ID}, {classifier.device})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
