CREATE TABLE IF NOT EXISTS products (
  sku text PRIMARY KEY,
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0),
  stock integer NOT NULL CHECK (stock >= 0)
);
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  customer_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  total_cents integer NOT NULL CHECK (total_cents > 0),
  payment_mode text NOT NULL CHECK (payment_mode IN ('success','temporary','declined')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id uuid REFERENCES orders(id),
  sku text REFERENCES products(sku),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (order_id, sku)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  order_id uuid NOT NULL REFERENCES orders(id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(available_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS payment_receipts (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  provider_reference text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
