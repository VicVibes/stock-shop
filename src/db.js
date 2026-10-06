const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'stock.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

db.exec(`
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
`);

// The application starts with the requested printing and material inventory.
function seed() {
  const oldSample = db.prepare(`SELECT COUNT(*) AS c FROM items
    WHERE is_sample = 1 AND name IN (?, ?, ?, ?, ?, ?)`,
    ['Bottled Water 500ml', 'Soft Drink 330ml', 'Biscuit Pack', 'Tissue Roll', 'Dish Soap 500ml', 'Sugar 1kg'])
    .get().c;
  if (oldSample > 0) {
    transaction(() => {
      db.prepare('DELETE FROM daily_counts WHERE item_id IN (SELECT id FROM items WHERE is_sample = 1)').run();
      db.prepare('DELETE FROM alerts WHERE item_id IN (SELECT id FROM items WHERE is_sample = 1)').run();
      db.prepare('DELETE FROM items WHERE is_sample = 1').run();
    });
  }

  const existingSample = db.prepare('SELECT COUNT(*) AS c FROM items WHERE is_sample = 1').get().c;
  if (existingSample > 0) return;

  const sample = [
    // name, category, unit, minimum shop, minimum store, opening shop, opening store
    ['Paper (6 cartons + rims)', 'Paper & Printing Materials', 'cartons', 1, 1, 6, 0],
    ['Paper (3 x 2 rims)', 'Paper & Printing Materials', 'packs', 1, 1, 3, 0],
    ['Passport Paper (13 packs)', 'Paper & Printing Materials', 'packs', 1, 1, 13, 0],
    ['A4 Glossy (2 packs)', 'Paper & Printing Materials', 'packs', 1, 1, 2, 0],
    ['ID Card Plastic (450)', 'ID Card Materials', 'pieces', 1, 1, 450, 0],
    ['Lamination ID Card (100)', 'ID Card Materials', 'rolls', 1, 1, 100, 0],
    ['Nylon File (89)', 'Files, Covers & Envelopes', 'pieces', 1, 1, 89, 0],
    ['Cover (14)', 'Files, Covers & Envelopes', 'pieces', 1, 1, 14, 0],
    ['Long Envelope (12)', 'Files, Covers & Envelopes', 'pieces', 1, 1, 12, 0],
    ['White Envelope Big (10)', 'Files, Covers & Envelopes', 'pieces', 1, 1, 10, 0],
    ['White Envelope (21)', 'Files, Covers & Envelopes', 'pieces', 1, 1, 21, 0],
    ['Small Envelope Brown (20)', 'Files, Covers & Envelopes', 'pieces', 1, 1, 20, 0],
    ['Brown Big Envelope (20)', 'Files, Covers & Envelopes', 'pieces', 1, 1, 20, 0],
    ['Back Spiral Bind (90)', 'Binding Materials', 'pieces', 1, 1, 90, 0],
    ['Front Spiral Bind (90)', 'Binding Materials', 'pieces', 1, 1, 90, 0],
    ['Big Stick (13)', 'Binding Materials', 'pieces', 1, 1, 13, 0],
    ['Small Stick (20)', 'Binding Materials', 'pieces', 1, 1, 20, 0],
  ];
  const ins = db.prepare(`INSERT INTO items (name, category, unit, min_shop, min_store,
    opening_shop, opening_store, is_sample) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`);
  transaction(() => sample.forEach((s) => ins.run(...s)));
}

module.exports = { db, seed, DB_PATH, transaction };
