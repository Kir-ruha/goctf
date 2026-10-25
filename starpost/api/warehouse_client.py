import json
import os
import urllib.request


WAREHOUSE_URL = os.getenv("WAREHOUSE_URL", "http://warehouse:6000")
CALLBACK_TOKEN = os.environ["WAREHOUSE_CALLBACK_TOKEN"]


def submit_jobs(orders):
    for order in orders:
        try:
            payload = json.dumps({"order_id": order["id"]}).encode()
            request = urllib.request.Request(
                f"{WAREHOUSE_URL}/jobs",
                data=payload,
                headers={"Content-Type": "application/json", "X-Warehouse-Token": CALLBACK_TOKEN},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=.4):
                pass
        except (OSError, ValueError):
            continue


def get_health():
    with urllib.request.urlopen(f"{WAREHOUSE_URL}/health", timeout=.5) as response:
        return json.loads(response.read())
