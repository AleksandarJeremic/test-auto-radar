#!/usr/bin/env python3
"""Auto Radar — local collector.

Standard library only: no pip, no venv, no Node. Run it, leave it running,
browse cars as you normally would.

    python3 server/server.py

Listens on 127.0.0.1 only — this is a personal collector, not a service.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import db

TOKEN_PATH = Path(__file__).with_name("token.txt")
DASHBOARD = Path(__file__).parent.parent / "dashboard" / "index.html"
MAX_BODY = 8 * 1024 * 1024  # a search page of ~50 ads is well under 1 MB


def load_or_create_token() -> str:
    """Generated once, on first run, and kept out of the repo."""
    if TOKEN_PATH.exists():
        token = TOKEN_PATH.read_text().strip()
        if token:
            return token
    token = secrets.token_urlsafe(24)
    TOKEN_PATH.write_text(token + "\n")
    TOKEN_PATH.chmod(0o600)
    return token


class Handler(BaseHTTPRequestHandler):
    server_version = "AutoRadar/0.1"
    conn: sqlite3.Connection
    token: str

    # ------------------------------------------------------------- plumbing

    def log_message(self, fmt, *args):  # quieter than the default access log
        if self.command != "OPTIONS":
            print(f"  {self.command} {self.path.split('?')[0]} — {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Radar-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _send(self, status: int, payload, content_type="application/json; charset=utf-8"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self) -> bool:
        return secrets.compare_digest(self.headers.get("X-Radar-Token", ""), self.token)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # --------------------------------------------------------------- routes

    def do_GET(self):
        route = urlparse(self.path)
        query = parse_qs(route.query)

        if route.path == "/health":
            return self._send(200, {"ok": True})

        # The dashboard is served from this same loopback origin, so it gets the
        # token baked in rather than asking the user to paste it twice.
        if route.path in ("/", "/index.html"):
            page = DASHBOARD.read_text(encoding="utf-8").replace("__RADAR_TOKEN__", self.token)
            return self._send(200, page.encode(), "text/html; charset=utf-8")

        if not self._authorised():
            return self._send(401, {"error": "bad or missing X-Radar-Token"})

        try:
            if route.path == "/api/summary":
                return self._send(200, db.summary(self.conn))
            if route.path == "/api/models":
                return self._send(200, db.models(self.conn))
            if route.path == "/api/listings":
                return self._send(200, db.listings(
                    self.conn,
                    limit=min(int(query.get("limit", ["200"])[0]), 2000),
                    brand=query.get("brand", [None])[0],
                    model=query.get("model", [None])[0],
                ))
            if route.path == "/api/drops":
                return self._send(200, db.price_drops(
                    self.conn, limit=min(int(query.get("limit", ["50"])[0]), 500)))
            if route.path.startswith("/api/history/"):
                # Listing ids contain ":" — percent-decode before looking them up.
                lid = unquote(route.path[len("/api/history/"):])
                found = db.history(self.conn, lid)
                return self._send(200 if found else 404, found or {"error": "not found"})
        except (ValueError, sqlite3.Error) as err:
            return self._send(400, {"error": str(err)})

        self._send(404, {"error": "unknown route"})

    def do_POST(self):
        if urlparse(self.path).path != "/ingest":
            return self._send(404, {"error": "unknown route"})
        if not self._authorised():
            return self._send(401, {"error": "bad or missing X-Radar-Token"})

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._send(413, {"error": "empty or oversized body"})

        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as err:
            return self._send(400, {"error": f"invalid JSON: {err}"})

        if not isinstance(payload, dict) or not isinstance(payload.get("listings"), list):
            return self._send(400, {"error": "expected {listings: [...]}"})

        try:
            result = db.ingest(self.conn, payload)
        except sqlite3.Error as err:
            return self._send(500, {"error": str(err)})

        if result["new"] or result["changed"]:
            print(f"  + {result['new']} novih, {result['changed']} promena cene "
                  f"({payload.get('page_type')})")
        return self._send(200, result)


def main():
    ap = argparse.ArgumentParser(description="Auto Radar collector")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    Handler.conn = db.connect()
    Handler.token = load_or_create_token()

    stats = db.summary(Handler.conn)
    print(f"\n  Auto Radar sluša na http://{args.host}:{args.port}")
    print(f"  Baza: {db.DB_PATH}")
    print(f"  Token: {TOKEN_PATH}  (otvori fajl i nalepi u ekstenziju)")
    print(f"  Trenutno: {stats['listings']} oglasa, {stats['snapshots']} snimaka cena\n")

    try:
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n  Zaustavljeno.")


if __name__ == "__main__":
    main()
