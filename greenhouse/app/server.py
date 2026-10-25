import hashlib
import json
import mimetypes
import os
import re
import secrets
import socket
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("GREENHOUSE_DATA", "/data"))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / "greenhouse.sqlite3"
PUBLIC_ID = "public"
PUBLIC_TOKEN = "visitor"
CONSOLE_SOCKET = DATA / "console.sock"
CONSOLE_SESSIONS = {}
CONSOLE_LOCK = threading.Lock()
CONSOLE_IDLE_SECONDS = 300
CONSOLE_LIMIT = 64


class ConsoleSession:
    def __init__(self):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.socket.settimeout(4)
            self.socket.connect(str(CONSOLE_SOCKET))
            self.stream = self.socket.makefile("rwb", buffering=0)
            self.lock = threading.Lock()
            self.last_used = time.monotonic()
            self.closed = False
            self.banner = [self.read_line(), self.read_line()]
        except Exception:
            if hasattr(self, "stream"):
                self.stream.close()
            self.socket.close()
            raise

    def read_line(self):
        line = self.stream.readline(65537)
        if not line or len(line) > 65536 or not line.endswith(b"\n"):
            raise ConnectionError("specimen console disconnected")
        return line.decode("utf-8", errors="replace").rstrip("\r\n")

    def command(self, line):
        with self.lock:
            if self.closed:
                raise ConnectionError("operator session closed")
            self.last_used = time.monotonic()
            self.stream.write((line + "\n").encode())
            reply = self.read_line()
            self.last_used = time.monotonic()
            return reply

    def close(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            try:
                self.stream.close()
            finally:
                self.socket.close()


def prune_consoles():
    now = time.monotonic()
    for session_id, session in list(CONSOLE_SESSIONS.items()):
        if now - session.last_used > CONSOLE_IDLE_SECONDS:
            CONSOLE_SESSIONS.pop(session_id, None)
            session.close()


def connection():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS plots (
        id TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT NOT NULL,
        cultivar TEXT NOT NULL, note TEXT NOT NULL, archive TEXT NOT NULL,
        created INTEGER DEFAULT (unixepoch()))""")
    db.execute("""CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY, plot TEXT NOT NULL, kind TEXT NOT NULL,
        value TEXT NOT NULL, created INTEGER DEFAULT (unixepoch()))""")
    db.execute("INSERT OR IGNORE INTO plots(id,token,name,cultivar,note,archive) VALUES (?,?,?,?,?,?)",
               (PUBLIC_ID, PUBLIC_TOKEN, "Публичный купол", "Helianthus orbitalis",
                "Добро пожаловать на станцию ОРБИТА.КВАНТУМ", "Калибровка открытого контура"))
    db.commit()
    return db


def row_public(row):
    return {"id": row["id"], "name": row["name"], "cultivar": row["cultivar"],
            "created": row["created"]}


def mask(id_, n):
    out = []
    counter = 0
    while len(out) < n:
        out.extend(hashlib.sha256(f"orbita-spectrum:{id_}:{counter}".encode()).digest())
        counter += 1
    return out[:n]


class Handler(BaseHTTPRequestHandler):
    server_version = "OrbitaOrangery/2126"

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    def reply(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 8192 or length < 0:
            raise ValueError("payload too large")
        return json.loads(self.rfile.read(length))

    def token(self, query):
        return self.headers.get("X-Greenhouse-Key", "") or query.get("key", [""])[0]

    def do_GET(self):
        parts = urlsplit(self.path)
        path = parts.path
        q = parse_qs(parts.query, keep_blank_values=True)
        if path == "/api/status":
            return self.reply(200, {"station": "ОРБИТА.КВАНТУМ", "module": "ОРАНЖЕРЕЯ",
                                    "year": 2126, "oxygen": 98.7, "temperature": 23.4,
                                    "state": "nominal"})
        if path.startswith("/api/"):
            return self.get_api(path, q)
        relative = path.lstrip("/") or "index.html"
        if relative.startswith("frontend/"):
            relative = relative.removeprefix("frontend/")
        frontend = ROOT / "frontend"
        target = (frontend / relative).resolve()
        if not target.is_relative_to(frontend) or not target.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".js":
            content_type = "text/javascript"
        content = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type + ("; charset=utf-8" if content_type.startswith("text/") or content_type in {"image/svg+xml", "application/json"} else ""))
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def get_api(self, path, q):
        with connection() as db:
            if path == "/api/plots":
                rows = db.execute("SELECT * FROM plots ORDER BY created DESC LIMIT 100").fetchall()
                return self.reply(200, {"plots": [row_public(r) for r in rows]})
            if path.startswith("/api/plots/"):
                id_ = path[len("/api/plots/"):]
                row = db.execute("SELECT * FROM plots WHERE id=?", (id_,)).fetchone()
                if row is None:
                    return self.reply(404, {"error": "unknown plot"})
                if self.token(q) != row["token"]:
                    return self.reply(403, {"error": "capability required"})
                return self.reply(200, {**row_public(row), "note": row["note"]})
            if path == "/api/archive":
                id_ = q.get("plot", [""])[0]
                row = db.execute("SELECT * FROM plots WHERE id=?", (id_,)).fetchone()
                if row is None:
                    return self.reply(404, {"error": "unknown plot"})
                if self.token(q) != row["token"]:
                    return self.reply(403, {"error": "capability required"})
                return self.reply(200, {"plot": id_, "archive": row["archive"]})
            if path == "/api/telemetry":
                id_ = q.get("plot", [""])[0]
                rows = db.execute("SELECT kind,value,created FROM telemetry WHERE plot=? ORDER BY id DESC LIMIT 40", (id_,)).fetchall()
                return self.reply(200, {"plot": id_, "telemetry": [dict(r) for r in rows]})
            if path == "/api/projection":
                target = q.get("target", [PUBLIC_ID])[0]
                anchor = target.split("#", 1)[0]
                anchor_row = db.execute("SELECT * FROM plots WHERE id=?", (anchor,)).fetchone()
                if anchor_row is None or self.token(q) != anchor_row["token"]:
                    return self.reply(403, {"error": "lens capability required"})
                focus = target.rsplit("#", 1)[-1]
                row = db.execute("SELECT * FROM plots WHERE id=?", (focus,)).fetchone()
                if row is None:
                    return self.reply(404, {"error": "no focus"})
                return self.reply(200, {"anchor": anchor, "focus": focus,
                                        "projection": {**row_public(row), "biometric_note": row["note"]}})
            if path == "/api/spectrum":
                id_ = q.get("plot", [""])[0]
                row = db.execute("SELECT archive FROM plots WHERE id=?", (id_,)).fetchone()
                if row is None:
                    return self.reply(404, {"error": "unknown plot"})
                raw = row["archive"].encode()
                salt = mask(id_, len(raw))
                previous = 0
                samples = []
                for byte, offset in zip(raw, salt):
                    value = (byte + previous + offset) % 257
                    samples.append(value)
                    previous = value
                return self.reply(200, {"plot": id_, "field": 257, "phase": "orbita-spectrum",
                                        "samples": samples})
        return self.reply(404, {"error": "unknown endpoint"})

    def do_POST(self):
        try:
            payload = self.body()
            if not isinstance(payload, dict):
                raise ValueError("object expected")
            if self.path == "/api/console/open":
                with CONSOLE_LOCK:
                    prune_consoles()
                    if len(CONSOLE_SESSIONS) >= CONSOLE_LIMIT:
                        return self.reply(429, {"error": "operator channels busy"})
                    try:
                        console = ConsoleSession()
                    except (OSError, ConnectionError) as exc:
                        return self.reply(503, {"error": f"specimen console unavailable: {exc}"})
                    session_id = secrets.token_hex(16)
                    CONSOLE_SESSIONS[session_id] = console
                return self.reply(201, {"session": session_id, "banner": console.banner})
            if self.path == "/api/console/command":
                session_id = payload.get("session")
                line = payload.get("command")
                if not isinstance(session_id, str) or not re.fullmatch(r"[0-9a-f]{32}", session_id):
                    raise ValueError("invalid operator session")
                if not isinstance(line, str) or not line.strip() or len(line) > 1024 or any(c in line for c in "\r\n\x00"):
                    raise ValueError("invalid console command")
                with CONSOLE_LOCK:
                    console = CONSOLE_SESSIONS.get(session_id)
                if console is None:
                    return self.reply(404, {"error": "operator session expired"})
                try:
                    result = console.command(line.strip())
                except (OSError, ConnectionError) as exc:
                    with CONSOLE_LOCK:
                        CONSOLE_SESSIONS.pop(session_id, None)
                    console.close()
                    return self.reply(502, {"error": f"specimen console disconnected: {exc}"})
                return self.reply(200, {"reply": result})
            if self.path == "/api/console/close":
                session_id = payload.get("session")
                if not isinstance(session_id, str) or not re.fullmatch(r"[0-9a-f]{32}", session_id):
                    raise ValueError("invalid operator session")
                with CONSOLE_LOCK:
                    console = CONSOLE_SESSIONS.pop(session_id, None)
                if console is not None:
                    console.close()
                return self.reply(200, {"ok": True})
            if self.path == "/api/plots":
                name = str(payload.get("name", ""))[:160]
                cultivar = str(payload.get("cultivar", ""))[:160]
                note = str(payload.get("note", ""))[:4000]
                archive = str(payload.get("archive", ""))[:512]
                if not name or not cultivar:
                    raise ValueError("name and cultivar required")
                id_ = secrets.token_hex(8)
                supplied = payload.get("key")
                token = str(supplied) if supplied is not None else secrets.token_hex(16)
                if not re.fullmatch(r"[0-9a-f]{32}", token):
                    raise ValueError("invalid capability")
                with connection() as db:
                    db.execute("INSERT INTO plots(id,token,name,cultivar,note,archive) VALUES (?,?,?,?,?,?)",
                               (id_, token, name, cultivar, note, archive))
                    db.commit()
                return self.reply(201, {"id": id_, "key": token})
            if self.path == "/api/telemetry":
                id_ = str(payload.get("plot", ""))
                kind = str(payload.get("kind", ""))[:32]
                value = str(payload.get("value", ""))[:128]
                if not id_ or not kind:
                    raise ValueError("invalid telemetry")
                with connection() as db:
                    if not db.execute("SELECT 1 FROM plots WHERE id=?", (id_,)).fetchone():
                        return self.reply(404, {"error": "unknown plot"})
                    db.execute("INSERT INTO telemetry(plot,kind,value) VALUES (?,?,?)", (id_, kind, value))
                    db.commit()
                return self.reply(201, {"ok": True})
            return self.reply(404, {"error": "unknown endpoint"})
        except (ValueError, json.JSONDecodeError) as exc:
            return self.reply(400, {"error": str(exc)})


if __name__ == "__main__":
    connection().close()
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
