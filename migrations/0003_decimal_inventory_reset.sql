PRAGMA foreign_keys = OFF;
DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS daily_counts;
DROP TABLE IF EXISTS adjustments;
DROP TABLE IF EXISTS movements;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS items;
PRAGMA foreign_keys = ON;

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category TEXT NOT NULL DEFAULT 'General',
  unit TEXT NOT NULL DEFAULT 'pcs',
  min_shop REAL NOT NULL DEFAULT 0 CHECK (min_shop >= 0),
  min_store REAL NOT NULL DEFAULT 0 CHECK (min_store >= 0),
  opening_shop REAL NOT NULL DEFAULT 0 CHECK (opening_shop >= 0),
  opening_store REAL NOT NULL DEFAULT 0 CHECK (opening_store >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  direction TEXT NOT NULL CHECK (direction IN ('STORE_TO_SHOP','SHOP_TO_STORE')),
  qty REAL NOT NULL CHECK (qty > 0), movement_date TEXT NOT NULL, note TEXT,
  user TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  shop_before REAL, shop_after REAL, store_before REAL, store_after REAL
);
CREATE TABLE adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id),
  location TEXT NOT NULL CHECK (location IN ('SHOP','STORE')), delta REAL NOT NULL CHECK (delta <> 0),
  reason TEXT NOT NULL, adj_date TEXT NOT NULL, user TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), before_qty REAL, after_qty REAL
);
CREATE TABLE daily_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id),
  count_date TEXT NOT NULL, system_qty REAL NOT NULL, physical_qty REAL NOT NULL CHECK (physical_qty >= 0),
  difference REAL NOT NULL, status TEXT NOT NULL, user TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (item_id, count_date)
);
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id), location TEXT, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN', created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT, resolution TEXT
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, action TEXT NOT NULL,
  details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_movements_item_date ON movements(item_id, movement_date);
CREATE INDEX idx_adjustments_item_date ON adjustments(item_id, adj_date);
CREATE INDEX idx_counts_date ON daily_counts(count_date);
CREATE INDEX idx_alerts_status ON alerts(status);

INSERT INTO items (name, category, unit, min_shop, min_store, opening_shop, opening_store) VALUES
 ('Spiral Bind Back','Binding Materials','pieces',1,1,10,75),
 ('Spiral Bind Front','Binding Materials','pieces',1,1,10,75),
 ('Concord White','Paper & Printing Materials','pieces',1,1,10,671),
 ('Concord Milk','Paper & Printing Materials','pieces',1,1,11,566),
 ('Cover Paper','Paper & Printing Materials','pieces',1,1,4,180),
 ('Art Card','Paper & Printing Materials','pieces',1,1,0,62),
 ('Long Brown Envelope','Files, Covers & Envelopes','pieces',1,1,25,100),
 ('Nylon File','Files, Covers & Envelopes','pieces',1,1,3,89),
 ('Small White Envelope','Files, Covers & Envelopes','pieces',1,1,8,207),
 ('Small Brown Envelope','Files, Covers & Envelopes','pieces',1,1,6,205),
 ('A4 Lamination','Paper & Printing Materials','pieces',1,1,1.5,45),
 ('Big Brown Envelope','Files, Covers & Envelopes','pieces',1,1,4,305),
 ('Big White Envelope','Files, Covers & Envelopes','pieces',1,1,0,10),
 ('Big Stick','Binding Materials','pieces',1,1,3,13),
 ('Small Stick','Binding Materials','pieces',1,1,3,198),
 ('ID Lamination','ID Card Materials','pieces',1,1,15,90),
 ('ID Card Plastic','ID Card Materials','pieces',1,1,8,437),
 ('Nylon Case (Portrait)','Files, Covers & Envelopes','pieces',1,1,4,37),
 ('Nylon Case (Landscape)','Files, Covers & Envelopes','pieces',1,1,3,94),
 ('Passport Paper','Paper & Printing Materials','packs',1,1,13,13),
 ('A4 Glossy','Paper & Printing Materials','packs',1,1,19,1),
 ('Paper A4','Paper & Printing Materials','rims',1,1,0,30),
 ('Ink PGBK','Printer Materials','pieces',1,1,0,2),
 ('Ink BK','Printer Materials','pieces',1,1,0,3),
 ('Ink Cyan','Printer Materials','pieces',1,1,0,3),
 ('Ink Magenta','Printer Materials','pieces',1,1,0,4),
 ('ID Card Case (Red)','ID Card Materials','pieces',1,1,0,97),
 ('ID Card Case (Black)','ID Card Materials','pieces',1,1,0,50),
 ('Pen','General','pieces',1,1,0,50);
