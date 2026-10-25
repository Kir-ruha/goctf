import os
import secrets
import threading
import time
import urllib.error
import urllib.request
import json
from datetime import datetime, timezone

from flask import Flask, jsonify, request


API_URL = os.environ["WAREHOUSE_API_URL"]
CALLBACK_TOKEN = os.environ["WAREHOUSE_CALLBACK_TOKEN"]
app = Flask(__name__)
jobs = {}
jobs_lock = threading.Lock()


def request_json(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json", "X-Warehouse-Token": CALLBACK_TOKEN}
    request = urllib.request.Request(f"{API_URL}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.loads(response.read())


def callback(job, stage):
    request_json("POST", "/api/warehouse/callback", {"order_id": job["order_id"], "job_id": job["job_id"], "stage": stage})
    with jobs_lock:
        job["stage"] = stage
        job["updated_at"] = datetime.now(timezone.utc).isoformat()


def process(job):
    try:
        for stage, delay in (("accepted", .05), ("picking", .18), ("in_transit", .18), ("arriving", .18), ("delivered", .18)):
            time.sleep(delay)
            callback(job, stage)
    except (OSError, ValueError, urllib.error.URLError):
        with jobs_lock:
            jobs.pop(job["job_id"], None)


def delivery_loop():
    while True:
        try:
            pending = request_json("GET", "/api/warehouse/pending")
            for order in pending:
                with jobs_lock:
                    known = any(job["order_id"] == order["id"] for job in jobs.values())
                    if known:
                        continue
                    job_id = "ATLAS-" + secrets.token_hex(8).upper()
                    job = {"job_id": job_id, "order_id": order["id"], "stage": "queued", "updated_at": datetime.now(timezone.utc).isoformat()}
                    jobs[job_id] = job
                threading.Thread(target=process, args=(job,), daemon=True).start()
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(.2)


@app.get("/health")
def health():
    return jsonify(status="ok", service="warehouse", bot="ATLAS-7")


@app.post("/jobs")
def create_job():
    if request.headers.get("X-Warehouse-Token") != CALLBACK_TOKEN:
        return jsonify(error="forbidden"), 403
    data = request.get_json(silent=True) or {}
    try:
        order_id = int(data["order_id"])
    except (KeyError, TypeError, ValueError):
        return jsonify(error="order_id is required"), 400
    with jobs_lock:
        for job in jobs.values():
            if job["order_id"] == order_id:
                return jsonify(job), 202
        job_id = "ATLAS-" + secrets.token_hex(8).upper()
        job = {"job_id": job_id, "order_id": order_id, "stage": "queued", "updated_at": datetime.now(timezone.utc).isoformat()}
        jobs[job_id] = job
    threading.Thread(target=process, args=(job,), daemon=True).start()
    return jsonify(job), 202


@app.get("/jobs/<job_id>")
def get_job(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    return (jsonify(job), 200) if job else (jsonify(error="job not found"), 404)


@app.get("/jobs")
def list_jobs():
    with jobs_lock:
        return jsonify(list(jobs.values())[-50:])


if __name__ == "__main__":
    threading.Thread(target=delivery_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=6000, threaded=True)
