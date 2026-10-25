import base64
import hashlib
import hmac
import json as _json
import mimetypes
import os
import secrets
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

import psycopg
from flask import Flask, jsonify, request, send_file, session
from werkzeug.security import check_password_hash, generate_password_hash

from contracts import CONTRACT_DIR, create_contract
from database import connect as db, migrate
from warehouse_client import CALLBACK_TOKEN as WAREHOUSE_CALLBACK_TOKEN
from warehouse_client import get_health as get_warehouse_health
from warehouse_client import submit_jobs as submit_warehouse_jobs


app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ["SECRET_KEY"],
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_PATH="/",
    MAX_CONTENT_LENGTH=32 * 1024,
)


migrate()


def now():
    return datetime.now(timezone.utc)


def body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


def error(message, status=400):
    return jsonify(error=message), status


def text(value, field, minimum=1, maximum=200):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ValueError(f"{field} length must be {minimum}..{maximum}")
    return value.strip()


def auth(role=None):
    def decorator(handler):
        @wraps(handler)
        def wrapped(*args, **kwargs):
            if "user_id" not in session:
                return error("authentication required", 401)
            if role and session["role"] != role:
                return error("forbidden", 403)
            return handler(*args, **kwargs)
        return wrapped
    return decorator


@app.get("/health")
def health():
    try:
        with db() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM users LIMIT 1")
    except psycopg.Error:
        return jsonify(status="starting", service="starpost-api"), 503
    return jsonify(status="ok", service="starpost-api")


@app.get("/api/integrity")
def integrity():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT contract_file FROM users WHERE role='seller' AND contract_file IS NOT NULL")
        contracts = [row["contract_file"] for row in cur.fetchall()]
    missing = sum(not (CONTRACT_DIR / filename).is_file() for filename in contracts)
    return jsonify(contracts=len(contracts), missing_contracts=missing, status="ok" if missing == 0 else "corrupt")


@app.get("/api/warehouse")
def warehouse():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) delivered FROM orders WHERE status='delivered'")
        delivered = cur.fetchone()["delivered"]
        cur.execute("SELECT warehouse_status,count(*) count FROM orders GROUP BY warehouse_status")
        stages = {row["warehouse_status"]: row["count"] for row in cur.fetchall()}
    try:
        warehouse_health = get_warehouse_health()
    except (OSError, ValueError):
        return jsonify(bot="ATLAS-7", status="offline", mode="automatic", delivered=delivered, stages=stages), 503
    if warehouse_health.get("status") != "ok":
        return jsonify(bot="ATLAS-7", status="offline", mode="automatic", delivered=delivered, stages=stages), 503
    return jsonify(bot=warehouse_health.get("bot", "ATLAS-7"), status="online", mode="automatic", delivered=delivered, stages=stages)


def worker_token_valid():
    return request.headers.get("X-Warehouse-Token") == WAREHOUSE_CALLBACK_TOKEN


@app.get("/api/warehouse/pending")
def warehouse_pending():
    if not worker_token_valid():
        return error("forbidden", 403)
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM orders WHERE status='pending' ORDER BY id LIMIT 50")
        return jsonify(cur.fetchall())


@app.post("/api/warehouse/callback")
def warehouse_callback():
    if not worker_token_valid():
        return error("forbidden", 403)
    data = body() or {}
    try:
        order_id = int(data["order_id"])
        stage = text(data.get("stage"), "stage", 3, 32)
        job_id = text(data.get("job_id"), "job_id", 3, 64)
    except (KeyError, TypeError, ValueError) as exc:
        return error(str(exc))
    allowed = {"accepted", "picking", "in_transit", "arriving", "delivered"}
    if stage not in allowed:
        return error("invalid warehouse stage")
    with db() as conn, conn.cursor() as cur:
        if stage == "delivered":
            cur.execute("UPDATE orders SET status='delivered',delivered_at=now(),warehouse_status=%s,warehouse_job_id=%s,warehouse_updated_at=now() WHERE id=%s AND status='pending' RETURNING id", (stage, job_id, order_id))
        else:
            cur.execute("UPDATE orders SET warehouse_status=%s,warehouse_job_id=%s,warehouse_updated_at=now() WHERE id=%s AND status='pending' RETURNING id", (stage, job_id, order_id))
        if not cur.fetchone():
            return error("pending order not found", 404)
    return jsonify(ok=True, order_id=order_id, job_id=job_id, stage=stage)


@app.post("/api/register")
def register():
    data = body()
    if not data:
        return error("invalid JSON")
    try:
        username, password = text(data.get("username"), "username", 3, 48), text(data.get("password"), "password", 8, 128)
        role = data.get("role")
        if role not in ("buyer", "seller"):
            raise ValueError("role must be buyer or seller")
        company = tax_id = signature = None
        if role == "seller":
            company, tax_id, signature = text(data.get("company_name"), "company_name", 2, 120), text(data.get("tax_id"), "tax_id", 4, 40), text(data.get("signature"), "signature", 4, 512)
    except ValueError as exc:
        return error(str(exc))
    try:
        with db() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO users(username,password_hash,role,company_name,tax_id) VALUES(%s,%s,%s,%s,%s) RETURNING id", (username, generate_password_hash(password), role, company, tax_id))
            user_id = cur.fetchone()["id"]
            if role == "seller":
                cur.execute("UPDATE users SET contract_file=%s WHERE id=%s", (create_contract(user_id, company, tax_id, signature), user_id))
            else:
                cur.execute(
                    "INSERT INTO promo_codes(user_id,code) VALUES(%s,%s)",
                    (user_id, "SP10-" + secrets.token_urlsafe(12).upper()),
                )
    except psycopg.errors.UniqueViolation:
        return error("username already exists", 409)
    session.clear()
    session.update(user_id=user_id, username=username, role=role)
    return jsonify(id=user_id, username=username, role=role), 201


@app.post("/api/login")
def login():
    data = body() or {}
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM users WHERE username=%s", (data.get("username"),))
        user = cur.fetchone()
    if not user or not isinstance(data.get("password"), str) or not check_password_hash(user["password_hash"], data["password"]):
        return error("invalid credentials", 401)
    session.clear()
    session.update(user_id=user["id"], username=user["username"], role=user["role"])
    return jsonify(id=user["id"], username=user["username"], role=user["role"])


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
@auth()
def me():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT id,username,role,balance,company_name,tax_id,contract_file FROM users WHERE id=%s", (session["user_id"],))
        return jsonify(cur.fetchone())


@app.get("/api/account")
@auth()
def account_summary():
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id,username,role,balance,company_name,tax_id,created_at
            FROM users WHERE id=%s
            """,
            (session["user_id"],),
        )
        user = cur.fetchone()
        if user["role"] == "buyer":
            cur.execute(
                """
                SELECT count(*) orders_count,
                       count(*) FILTER (WHERE status='delivered') delivered_count,
                       COALESCE(sum(price),0) spent
                FROM orders WHERE buyer_id=%s
                """,
                (session["user_id"],),
            )
            stats = cur.fetchone()
            cur.execute(
                """
                SELECT o.id,o.status,o.warehouse_status,o.price,o.tracking_code,o.created_at,p.name
                FROM orders o JOIN products p ON p.id=o.product_id
                WHERE o.buyer_id=%s ORDER BY o.id DESC LIMIT 5
                """,
                (session["user_id"],),
            )
            recent_orders = cur.fetchall()
            cur.execute(
                "SELECT count(*) reviews_count FROM reviews WHERE buyer_id=%s",
                (session["user_id"],),
            )
            reviews_count = cur.fetchone()["reviews_count"]
            cur.execute("SELECT code,amount FROM promo_codes WHERE user_id=%s", (session["user_id"],))
            return jsonify(user=user, stats=stats, reviews_count=reviews_count, recent_orders=recent_orders, promo=cur.fetchone())

        cur.execute(
            """
            SELECT count(*) products_count,
                   count(*) FILTER (WHERE is_active=true) active_products_count
            FROM products WHERE seller_id=%s
            """,
            (session["user_id"],),
        )
        stats = cur.fetchone()
        cur.execute(
            "SELECT count(*) reviews_count FROM reviews WHERE seller_id=%s",
            (session["user_id"],),
        )
        reviews_count = cur.fetchone()["reviews_count"]
        return jsonify(user=user, stats=stats, reviews_count=reviews_count)


def current_promo(code):
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM promo_codes WHERE user_id=%s AND code=%s", (session["user_id"], code))
        return conn, cur, cur.fetchone()


@app.post("/api/promo/credit")
@auth("buyer")
def credit_promo():
    data = body() or {}
    code = data.get("code")
    if not isinstance(code, str) or not 1 <= len(code) <= 100:
        return error("invalid promo code")
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT amount FROM promo_codes WHERE user_id=%s AND code=%s", (session["user_id"], code.strip()))
        promo = cur.fetchone()
        if not promo:
            return error("promo code is unavailable", 409)
        cur.execute("UPDATE users SET balance=balance+%s WHERE id=%s", (promo["amount"], session["user_id"]))
    return jsonify(credited=promo["amount"], code=code.strip())


@app.post("/api/promo/invalidate")
@auth("buyer")
def invalidate_promo():
    data = body() or {}
    code = data.get("code")
    if not isinstance(code, str) or not 1 <= len(code) <= 100:
        return error("invalid promo code")
    with db() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM promo_codes WHERE user_id=%s AND code=%s", (session["user_id"], code.strip()))
        if cur.rowcount == 0:
            return error("promo code is unavailable", 409)
    return jsonify(invalidated=True, code=code.strip())


@app.get("/api/products")
def products():
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id,p.name,p.description,p.price,p.created_at,u.company_name seller,
              (SELECT count(*) FROM reviews r JOIN orders o ON o.id=r.order_id
               WHERE o.product_id=p.id AND r.is_private=false) review_count,
              COALESCE((
                SELECT json_agg(item) FROM (
                  SELECT r.rating,r.body,b.username buyer,r.created_at
                  FROM reviews r
                  JOIN orders o ON o.id=r.order_id
                  JOIN users b ON b.id=r.buyer_id
                  WHERE o.product_id=p.id AND r.is_private=false
                  ORDER BY r.id DESC LIMIT 3
                ) item
              ), '[]'::json) reviews
            FROM products p JOIN users u ON u.id=p.seller_id
            WHERE p.is_active=true
            ORDER BY p.id DESC LIMIT 100
            """
        )
        return jsonify(cur.fetchall())


@app.get("/api/products/<int:product_id>")
def product_details(product_id):
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id,p.name,p.description,p.price,p.created_at,
                   u.company_name seller,u.tax_id seller_tax_id,
                   count(r.id) FILTER (WHERE r.is_private=false) review_count,
                   COALESCE(round(avg(r.rating) FILTER (WHERE r.is_private=false), 1), 0) rating
            FROM products p
            JOIN users u ON u.id=p.seller_id
            LEFT JOIN orders o ON o.product_id=p.id
            LEFT JOIN reviews r ON r.order_id=o.id
            WHERE p.id=%s AND p.is_active=true
            GROUP BY p.id,u.company_name,u.tax_id
            """,
            (product_id,),
        )
        product = cur.fetchone()
        if not product:
            return error("product not found", 404)
        cur.execute(
            """
            SELECT r.id,r.rating,r.body,r.created_at,b.username buyer
            FROM reviews r
            JOIN orders o ON o.id=r.order_id
            JOIN users b ON b.id=r.buyer_id
            WHERE o.product_id=%s AND r.is_private=false
            ORDER BY r.id DESC LIMIT 50
            """,
            (product_id,),
        )
        product["reviews"] = cur.fetchall()
        return jsonify(product)


@app.post("/api/products")
@auth("seller")
def add_product():
    data = body() or {}
    try:
        name, description, cargo = text(data.get("name"), "name", 2, 100), text(data.get("description"), "description", 2, 500), text(data.get("cargo"), "cargo", 1, 1024)
        price = int(data.get("price"))
        if not 1 <= price <= 1000:
            raise ValueError("price must be 1..1000")
    except (TypeError, ValueError) as exc:
        return error(str(exc))
    with db() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO products(seller_id,name,description,price,cargo) VALUES(%s,%s,%s,%s,%s) RETURNING id", (session["user_id"], name, description, price, cargo))
        return jsonify(id=cur.fetchone()["id"]), 201


@app.get("/api/seller/products")
@auth("seller")
def seller_products():
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT p.id,p.name,p.description,p.price,p.cargo,p.is_active,p.created_at,
                   count(o.id) sales_count,COALESCE(sum(o.price),0) income
            FROM products p
            LEFT JOIN orders o ON o.product_id=p.id
            WHERE p.seller_id=%s
            GROUP BY p.id
            ORDER BY p.id DESC
            """,
            (session["user_id"],),
        )
        return jsonify(cur.fetchall())


@app.patch("/api/seller/products/<int:product_id>")
@auth("seller")
def update_seller_product(product_id):
    data = body() or {}
    try:
        name = text(data.get("name"), "name", 2, 100)
        description = text(data.get("description"), "description", 2, 500)
        price = int(data.get("price"))
        if not 1 <= price <= 1000:
            raise ValueError("price must be 1..1000")
        is_active = data.get("is_active")
        if not isinstance(is_active, bool):
            raise ValueError("is_active must be boolean")
    except (TypeError, ValueError) as exc:
        return error(str(exc))
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE products SET name=%s,description=%s,price=%s,is_active=%s
            WHERE id=%s AND seller_id=%s RETURNING id,is_active
            """,
            (name, description, price, is_active, product_id, session["user_id"]),
        )
        product = cur.fetchone()
        if not product:
            return error("product not found", 404)
    return jsonify(product)


@app.delete("/api/seller/products/<int:product_id>")
@auth("seller")
def archive_seller_product(product_id):
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE products SET is_active=false WHERE id=%s AND seller_id=%s RETURNING id",
            (product_id, session["user_id"]),
        )
        if not cur.fetchone():
            return error("product not found", 404)
    return jsonify(ok=True, archived=True)


@app.post("/api/cart")
@auth("buyer")
def add_cart():
    data = body() or {}
    product_id = data.get("product_id")
    try:
        quantity = int(data.get("quantity", 1))
        if not 1 <= quantity <= 10:
            raise ValueError("quantity must be 1..10")
    except (TypeError, ValueError) as exc:
        return error(str(exc))
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT seller_id FROM products WHERE id=%s AND is_active=true", (product_id,))
        product = cur.fetchone()
        if not product:
            return error("product not found", 404)
        if product["seller_id"] == session["user_id"]:
            return error("cannot add your own product")
        cur.execute(
            """
            INSERT INTO cart_items(buyer_id,product_id,quantity) VALUES(%s,%s,%s)
            ON CONFLICT(buyer_id,product_id) DO UPDATE
            SET quantity=LEAST(10, cart_items.quantity + EXCLUDED.quantity)
            RETURNING quantity
            """,
            (session["user_id"], product_id, quantity),
        )
        quantity = cur.fetchone()["quantity"]
    return jsonify(ok=True, quantity=quantity), 201


@app.get("/api/cart")
@auth("buyer")
def get_cart():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT p.id,p.name,p.description,p.price,c.quantity,u.company_name seller FROM cart_items c JOIN products p ON p.id=c.product_id JOIN users u ON u.id=p.seller_id WHERE c.buyer_id=%s ORDER BY c.created_at", (session["user_id"],))
        return jsonify(cur.fetchall())


@app.delete("/api/cart/<int:product_id>")
@auth("buyer")
def delete_cart(product_id):
    with db() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM cart_items WHERE buyer_id=%s AND product_id=%s", (session["user_id"], product_id))
    return jsonify(ok=True)


@app.patch("/api/cart/<int:product_id>")
@auth("buyer")
def update_cart_quantity(product_id):
    try:
        quantity = int((body() or {}).get("quantity"))
        if not 1 <= quantity <= 10:
            raise ValueError("quantity must be 1..10")
    except (TypeError, ValueError) as exc:
        return error(str(exc))
    with db() as conn, conn.cursor() as cur:
        cur.execute("UPDATE cart_items SET quantity=%s WHERE buyer_id=%s AND product_id=%s RETURNING quantity", (quantity, session["user_id"], product_id))
        if not cur.fetchone():
            return error("cart item not found", 404)
    return jsonify(ok=True, quantity=quantity)


def order_product(product_id):
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT p.*,u.balance FROM products p CROSS JOIN users u WHERE p.id=%s AND p.is_active=true AND u.id=%s FOR UPDATE OF u", (product_id, session["user_id"]))
        row = cur.fetchone()
        if not row:
            return None, error("product not found", 404)
        if row["seller_id"] == session["user_id"]:
            return None, error("cannot buy your own product")
        if row["balance"] < row["price"]:
            return None, error("insufficient balance", 409)
        cur.execute("UPDATE users SET balance=balance-%s WHERE id=%s", (row["price"], session["user_id"]))
        cur.execute("UPDATE users SET balance=balance+%s WHERE id=%s", (row["price"], row["seller_id"]))
        tracking = "ORB-" + secrets.token_hex(8).upper()
        cur.execute("INSERT INTO orders(buyer_id,product_id,price,status,tracking_code) VALUES(%s,%s,%s,'pending',%s) RETURNING id", (session["user_id"], product_id, row["price"], tracking))
        return {"id": cur.fetchone()["id"], "status": "pending", "tracking_code": tracking}, None


@app.post("/api/products/<int:product_id>/buy")
@auth("buyer")
def buy_product(product_id):
    result, failure = order_product(product_id)
    if failure:
        return failure
    submit_warehouse_jobs([result])
    return jsonify(result), 201


@app.post("/api/cart/checkout")
@auth("buyer")
def checkout():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT balance FROM users WHERE id=%s FOR UPDATE", (session["user_id"],))
        buyer = cur.fetchone()
        cur.execute(
            """
            SELECT p.id product_id,p.seller_id,p.price,p.is_active,c.quantity
            FROM cart_items c JOIN products p ON p.id=c.product_id
            WHERE c.buyer_id=%s ORDER BY c.created_at
            """,
            (session["user_id"],),
        )
        items = cur.fetchall()
        if not items:
            return error("cart is empty", 409)
        if any(not item["is_active"] for item in items):
            return error("cart contains archived product", 409)
        total = sum(item["price"] * item["quantity"] for item in items)
        if buyer["balance"] < total:
            return error("insufficient balance", 409)
        cur.execute("UPDATE users SET balance=balance-%s WHERE id=%s", (total, session["user_id"]))
        orders = []
        for item in items:
            cur.execute("UPDATE users SET balance=balance+%s WHERE id=%s", (item["price"] * item["quantity"], item["seller_id"]))
            for _ in range(item["quantity"]):
                tracking = "ORB-" + secrets.token_hex(8).upper()
                cur.execute(
                    "INSERT INTO orders(buyer_id,product_id,price,status,tracking_code) VALUES(%s,%s,%s,'pending',%s) RETURNING id",
                    (session["user_id"], item["product_id"], item["price"], tracking),
                )
                orders.append({"id": cur.fetchone()["id"], "status": "pending", "tracking_code": tracking})
        cur.execute("DELETE FROM cart_items WHERE buyer_id=%s", (session["user_id"],))
    submit_warehouse_jobs(orders)
    return jsonify(orders=orders), 201


@app.get("/api/orders")
@auth("buyer")
def buyer_orders():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT o.id,o.status,o.warehouse_status,o.warehouse_updated_at,o.tracking_code,o.price,o.created_at,o.delivered_at,p.name,CASE WHEN o.status='delivered' THEN p.cargo ELSE NULL END cargo FROM orders o JOIN products p ON p.id=o.product_id WHERE o.buyer_id=%s ORDER BY o.id DESC", (session["user_id"],))
        return jsonify(cur.fetchall())


@app.get("/api/seller/sales")
@auth("seller")
def seller_sales():
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT o.id,o.price,o.status,o.tracking_code,o.created_at,p.name,b.username buyer FROM orders o JOIN products p ON p.id=o.product_id JOIN users b ON b.id=o.buyer_id WHERE p.seller_id=%s ORDER BY o.id DESC", (session["user_id"],))
        sales = cur.fetchall()
    return jsonify(income=sum(row["price"] for row in sales), sales=sales)


@app.post("/api/orders/<int:order_id>/review")
@auth("buyer")
def review(order_id):
    data = body() or {}
    try:
        review_body, rating = text(data.get("body"), "body", 1, 1000), int(data.get("rating"))
        if rating not in range(1, 6):
            raise ValueError("rating must be 1..5")
    except (TypeError, ValueError) as exc:
        return error(str(exc))
    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT p.seller_id FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=%s AND o.buyer_id=%s AND o.status='delivered'", (order_id, session["user_id"]))
        order = cur.fetchone()
        if not order:
            return error("delivered order not found", 404)
        try:
            cur.execute("INSERT INTO reviews(order_id,buyer_id,seller_id,rating,body,is_private) VALUES(%s,%s,%s,%s,%s,%s) RETURNING id", (order_id, session["user_id"], order["seller_id"], rating, review_body, data.get("private") is True))
        except psycopg.errors.UniqueViolation:
            return error("order already reviewed", 409)
        return jsonify(id=cur.fetchone()["id"]), 201


@app.get("/api/seller/reviews")
@auth("seller")
def seller_reviews():
    cursor = request.args.get("cursor")
    limit_raw = request.args.get("limit")
    def _b64e(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).decode().rstrip("=")

    def _b64d(s: str) -> bytes:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

    def _sign(payload_b64: str) -> str:
        return hmac.new(app.config["SECRET_KEY"].encode(), payload_b64.encode(), hashlib.sha256).hexdigest()[:16]

    def _make_cursor(state: dict) -> str:
        p = _b64e(_json.dumps(state, separators=(",", ":")).encode())
        return f"{p}.{_sign(p)}"

    def _parse_cursor(cur_token: str, lim_raw):
        try:
            lim = int(lim_raw) if lim_raw is not None else None
        except (TypeError, ValueError):
            lim = None
        if lim is not None and lim <= 3:
            return _json.loads(_b64d(cur_token.split(".")[0]).decode())
        if "." not in cur_token:
            raise ValueError("missing signature")
        payload_b64, sig = cur_token.rsplit(".", 1)
        if not hmac.compare_digest(_sign(payload_b64), sig):
            raise ValueError("bad cursor signature")
        return _json.loads(_b64d(payload_b64).decode())

    limit = 20
    if limit_raw is not None:
        try:
            limit = int(limit_raw)
            if not 1 <= limit <= 100:
                return error("limit must be 1..100")
        except (TypeError, ValueError):
            return error("invalid limit")

    if cursor:
        try:
            state = _parse_cursor(cursor, limit_raw)
        except Exception as exc:
            return error(f"invalid cursor: {exc}", 400)
        try:
            q_seller = int(state["seller_id"])
            q_private = bool(state["is_private"])
            q_last = int(state["last_id"])
        except (KeyError, TypeError, ValueError):
            return error("invalid cursor payload", 400)
        with db() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT r.id,r.rating,r.body,r.is_private,r.created_at,p.name,b.username buyer "
                "FROM reviews r JOIN orders o ON o.id=r.order_id "
                "JOIN products p ON p.id=o.product_id JOIN users b ON b.id=r.buyer_id "
                "WHERE r.seller_id=%s AND r.is_private=%s AND r.id < %s "
                "ORDER BY r.id DESC LIMIT %s",
                (q_seller, q_private, q_last, limit),
            )
            rows = cur.fetchall()
        next_cursor = None
        if rows:
            next_cursor = _make_cursor(
                {"seller_id": q_seller, "is_private": q_private, "last_id": rows[-1]["id"], "v": 2}
            )
        return jsonify(reviews=rows, next_cursor=next_cursor)
    with db() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT r.id,r.rating,r.body,r.is_private,r.created_at,p.name,b.username buyer "
            "FROM reviews r JOIN orders o ON o.id=r.order_id "
            "JOIN products p ON p.id=o.product_id JOIN users b ON b.id=r.buyer_id "
            "WHERE r.seller_id=%s AND r.id < %s "
            "ORDER BY r.id DESC LIMIT %s",
            (session["user_id"], 1_000_000_000, limit),
        )
        rows = cur.fetchall()
    next_cursor = None
    if rows:
        last_private = rows[-1]["is_private"]
        next_cursor = _make_cursor(
            {"seller_id": session["user_id"], "is_private": bool(last_private), "last_id": rows[-1]["id"], "v": 2}
        )
    return jsonify(reviews=rows, next_cursor=next_cursor)


@app.route("/api/contract", methods=["GET", "POST"])
@auth("seller")
def get_contract():
    if request.method == "POST":
        import re
        contract_id = request.headers.get("X-Contract-Id", "").strip()
        if not re.fullmatch(r"\d+", contract_id):
            return error("invalid contract id", 400)
        _dir = CONTRACT_DIR.resolve()
        hits = sorted(CONTRACT_DIR.glob(f"contract-{contract_id}-*.pdf"))
        deleted = 0
        for path in hits:
            try:
                if path.resolve().parent == _dir:
                    path.unlink()
                    deleted += 1
            except OSError:
                continue
        if deleted == 0:
            return error("contract not found", 404)
        return jsonify(status="deleted", deleted=deleted)

    requested = request.args.get("file")

    if requested:
        import re
        m = re.match(r"^\s*contract-(\d+)", requested)
        if m:
            uid = m.group(1)
            hits = sorted(CONTRACT_DIR.glob(f"contract-{uid}-*.pdf"))
            if hits:
                return send_file(hits[0], mimetype="application/pdf", download_name=hits[0].name)
            return error("contract not found", 404)
        raw = requested.strip()
        candidates: list[Path] = []
        candidates.append((CONTRACT_DIR / raw).resolve())
        candidates.append(Path(raw).resolve())
        candidates.append(CONTRACT_DIR / raw)
        candidates.append(Path(raw))
        for target in candidates:
            try:
                if target.is_file():
                    guessed, _ = mimetypes.guess_type(str(target))
                    return send_file(target, mimetype=guessed or "application/octet-stream", download_name=target.name)
            except ValueError:
                continue
        return error("contract not found", 404)

    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT contract_file FROM users WHERE id=%s", (session["user_id"],))
        filename = cur.fetchone()["contract_file"]
    path = CONTRACT_DIR / filename
    if not path.is_file():
        return error("contract not found", 404)
    return send_file(path, mimetype="application/pdf", download_name="starpost-contract.pdf")