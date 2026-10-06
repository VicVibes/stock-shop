CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category TEXT NOT NULL DEFAULT 'General',
  unit TEXT NOT NULL DEFAULT 'pcs',
  min_shop INTEGER NOT NULL DEFAULT 0 CHECK (min_shop >= 0),
  min_store INTEGER NOT NULL DEFAULT 0 CHECK (min_store >= 0),
  opening_shop INTEGER NOT NULL DEFAULT 0 CHECK (opening_shop >= 0),
  opening_store INTEGER NOT NULL DEFAULT 0 CHECK (opening_store >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT UNIQUE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  direction TEXT NOT NULL CHECK (direction IN ('STORE_TO_SHOP','SHOP_TO_STORE')),
  qty INTEGER NOT NULL CHECK (qty > 0),
  movement_date TEXT NOT NULL,
  note TEXT,
  user TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  shop_before INTEGER, shop_after INTEGER,
  store_before INTEGER, store_after INTEGER
);

CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  location TEXT NOT NULL CHECK (location IN ('SHOP','STORE')),
  delta INTEGER NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL,
  adj_date TEXT NOT NULL,
  user TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  before_qty INTEGER, after_qty INTEGER
);

CREATE TABLE IF NOT EXISTS daily_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  count_date TEXT NOT NULL,
  system_qty INTEGER NOT NULL,
  physical_qty INTEGER NOT NULL CHECK (physical_qty >= 0),
  difference INTEGER NOT NULL,
  status TEXT NOT NULL,
  user TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, count_date)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  location TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_movements_item_date ON movements(item_id, movement_date);
CREATE INDEX IF NOT EXISTS idx_adjustments_item_date ON adjustments(item_id, adj_date);
CREATE INDEX IF NOT EXISTS idx_counts_date ON daily_counts(count_date);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
