import os

import psycopg
from psycopg.rows import dict_row


DATABASE_URL = os.environ["DATABASE_URL"]


def connect():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def migrate():
    with connect() as connection, connection.cursor() as cursor:
        cursor.execute("DROP TABLE IF EXISTS promos")
        cursor.execute("DROP TABLE IF EXISTS private_promos")
        cursor.execute("ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1")
        cursor.execute(
            """
            DO $$ BEGIN
              ALTER TABLE cart_items ADD CONSTRAINT cart_items_quantity_check CHECK(quantity BETWEEN 1 AND 10);
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
            """
        )
        cursor.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true")
        cursor.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS warehouse_status TEXT NOT NULL DEFAULT 'queued'")
        cursor.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS warehouse_job_id TEXT")
        cursor.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS warehouse_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()")
        cursor.execute(
            """
            CREATE TABLE IF NOT EXISTS promo_codes (
              id BIGSERIAL PRIMARY KEY,
              user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
              code TEXT NOT NULL UNIQUE,
              amount INTEGER NOT NULL DEFAULT 100 CHECK(amount = 100)
            )
            """
        )
        cursor.execute("ALTER TABLE promo_codes DROP COLUMN IF EXISTS is_active")
        cursor.execute(
            """
            DO $$ DECLARE r RECORD; BEGIN
              FOR r IN SELECT conname FROM pg_constraint
                       WHERE conrelid = 'promo_codes'::regclass AND contype = 'c' LOOP
                EXECUTE format('ALTER TABLE promo_codes DROP CONSTRAINT %I', r.conname);
              END LOOP;
              ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_amount_check CHECK(amount = 100);
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
            """
        )
        cursor.execute("ALTER TABLE promo_codes ALTER COLUMN amount SET DEFAULT 100")
        cursor.execute("ALTER TABLE users ALTER COLUMN balance SET DEFAULT 100")
        cursor.execute("ALTER TABLE promo_codes DROP COLUMN IF EXISTS credited_at")
        cursor.execute("ALTER TABLE promo_codes DROP COLUMN IF EXISTS invalidated_at")
        cursor.execute("ALTER TABLE promo_codes DROP COLUMN IF EXISTS created_at")
        cursor.execute("CREATE INDEX IF NOT EXISTS orders_buyer_idx ON orders(buyer_id, id DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS orders_product_idx ON orders(product_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS products_seller_idx ON products(seller_id, id DESC)")
        cursor.execute("CREATE INDEX IF NOT EXISTS reviews_seller_idx ON reviews(seller_id, id DESC)")
