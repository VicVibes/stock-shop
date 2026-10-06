const { db, DB_PATH, transaction } = require('./db');

// ---------- helpers ----------
const localDate = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const today = () => localDate();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function isDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !isNaN(t) && t.toISOString().slice(0, 10) === d;
}
function checkDate(d) {
  if (!isDate(d)) throw fail('Invalid date. Use YYYY-MM-DD.');
  if (d > today()) throw fail('Date cannot be in the future.');
  return d;
}
function toInt(v, label, min = 0) {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  if (!Number.isInteger(n) || n < min) {
    throw fail(`${label} must be a whole number ${min > 0 ? 'greater than zero' : '0 or more'}.`);
  }
  return n;
}
function audit(user, action, details) {
  db.prepare('INSERT INTO audit_log (user, action, details) VALUES (?, ?, ?)')
    .run(user, action, JSON.stringify(details));
}
function upsertAlert(refKey, kind, itemId, location, message) {
  db.prepare(`INSERT INTO alerts (ref_key, kind, item_id, location, message) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ref_key) DO UPDATE SET
      kind = excluded.kind,
      message = excluded.message,
      status = CASE WHEN alerts.status = 'CLEARED' THEN 'OPEN' ELSE alerts.status END,
      resolved_at = CASE WHEN alerts.status = 'CLEARED' THEN NULL ELSE alerts.resolved_at END,
      resolution = CASE WHEN alerts.status = 'CLEARED' THEN NULL ELSE alerts.resolution END`)
    .run(refKey, kind, itemId, location, message);
}

// ---------- balances: the ONE place stock is calculated ----------
// asOf = YYYY-MM-DD (inclusive) or null for current balances.
function balances(asOf = null) {
  const mF = asOf ? 'AND m.movement_date <= ?' : '';
  const aF = asOf ? 'AND a.adj_date <= ?' : '';
  const net = `COALESCE((SELECT SUM(CASE m.direction WHEN 'STORE_TO_SHOP' THEN m.qty ELSE -m.qty END)
                 FROM movements m WHERE m.item_id = i.id ${mF}), 0)`;
  const adj = (loc) => `COALESCE((SELECT SUM(a.delta) FROM adjustments a
                 WHERE a.item_id = i.id AND a.location = '${loc}' ${aF}), 0)`;
  const sql = `
    SELECT i.id, i.name, i.category, i.unit, i.active, i.is_sample, i.min_shop, i.min_store,
           i.opening_shop + ${net} + ${adj('SHOP')} AS shop,
           i.opening_store - ${net} + ${adj('STORE')} AS store
    FROM items i ORDER BY i.name COLLATE NOCASE`;
  const stmt = db.prepare(sql);
  return asOf ? stmt.all(asOf, asOf, asOf) : stmt.all();
}
function balanceOf(itemId, asOf = null) {
  const r = balances(asOf).find((x) => x.id === itemId);
  if (!r) throw fail('Item not found.', 404);
  return r;
}

// Accepts an id or a (partial) name. Used by the UI and the assistant.
function findItem(ref) {
  if (ref === undefined || ref === null || String(ref).trim() === '') throw fail('Item is required.');
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) {
    const byId = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(s));
    if (byId) return byId;
  }
  const exact = db.prepare('SELECT * FROM items WHERE name = ? COLLATE NOCASE').get(s);
  if (exact) return exact;
  const like = db.prepare('SELECT * FROM items WHERE name LIKE ? COLLATE NOCASE').all(`%${s}%`);
  if (like.length === 1) return like[0];
  if (like.length > 1) {
    throw fail(`"${s}" matches ${like.length} items (${like.slice(0, 5).map((i) => i.name).join(', ')}). Be more specific.`);
  }
  throw fail(`No item matches "${s}".`, 404);
}

// ---------- items ----------
function listItems(includeInactive = true) {
  return db.prepare(`SELECT * FROM items ${includeInactive ? '' : 'WHERE active = 1'}
    ORDER BY active DESC, name COLLATE NOCASE`).all();
}

function createItem(data, user) {
  const name = String(data.name || '').trim();
  if (!name) throw fail('Item name is required.');
  const row = {
    name,
    category: String(data.category || 'General').trim() || 'General',
    unit: String(data.unit || 'pcs').trim() || 'pcs',
    min_shop: toInt(data.min_shop ?? 0, 'Shop minimum'),
    min_store: toInt(data.min_store ?? 0, 'Store minimum'),
    opening_shop: toInt(data.opening_shop ?? 0, 'Opening Shop quantity'),
    opening_store: toInt(data.opening_store ?? 0, 'Opening Store quantity'),
  };
  try {
    const info = db.prepare(`INSERT INTO items (name, category, unit, min_shop, min_store, opening_shop, opening_store)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        row.name,
        row.category,
        row.unit,
        row.min_shop,
        row.min_store,
        row.opening_shop,
        row.opening_store,
      );
    audit(user, 'item.create', { id: info.lastInsertRowid, ...row });
    return db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw fail(`An item named "${name}" already exists.`, 409);
    throw e;
  }
}

function updateItem(id, data, user) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!item) throw fail('Item not found.', 404);
  const next = { ...item };
  for (const k of ['name', 'category', 'unit']) {
    if (data[k] !== undefined) {
      next[k] = String(data[k]).trim();
      if (!next[k]) throw fail(`${k} cannot be empty.`);
    }
  }
  for (const k of ['min_shop', 'min_store', 'opening_shop', 'opening_store']) {
    if (data[k] !== undefined) next[k] = toInt(data[k], k.replace('_', ' '));
  }
  if (data.active !== undefined) next.active = data.active ? 1 : 0;

  // Opening quantities feed balances; make sure changing them cannot create negatives.
  if (next.opening_shop !== item.opening_shop || next.opening_store !== item.opening_store) {
    const cur = balanceOf(id);
    const shop = cur.shop - item.opening_shop + next.opening_shop;
    const store = cur.store - item.opening_store + next.opening_store;
    if (shop < 0 || store < 0) throw fail('This opening quantity would make a balance negative.');
  }
  try {
    db.prepare(`UPDATE items SET name=?, category=?, unit=?, min_shop=?,
      min_store=?, opening_shop=?, opening_store=?, active=?
      WHERE id=?`).run(
        next.name,
        next.category,
        next.unit,
        next.min_shop,
        next.min_store,
        next.opening_shop,
        next.opening_store,
        next.active,
        id,
      );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw fail('Another item already has that name.', 409);
    throw e;
  }
  audit(user, 'item.update', { id, before: item, after: next });
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
}

// ---------- transfers (atomic, idempotent, never negative) ----------
const DIRECTIONS = ['STORE_TO_SHOP', 'SHOP_TO_STORE'];
function transfer(data, user) {
  const qty = toInt(data.qty, 'Quantity', 1);
  const date = checkDate(data.date || today());
  if (!DIRECTIONS.includes(data.direction)) throw fail('Direction must be STORE_TO_SHOP or SHOP_TO_STORE.');
  const item = findItem(data.item_id ?? data.item);
  if (!item.active) throw fail(`"${item.name}" is inactive. Reactivate it to move stock.`);
  const requestId = data.request_id ? String(data.request_id) : null;
  const note = data.note ? String(data.note).trim().slice(0, 200) : null;

  return transaction(() => {
    if (requestId) {
      const dup = db.prepare('SELECT * FROM movements WHERE request_id = ?').get(requestId);
      if (dup) return { ...dup, duplicate: true };
    }
    const src = data.direction === 'STORE_TO_SHOP' ? 'store' : 'shop';
    const now = balanceOf(item.id);
    const onDate = balanceOf(item.id, date);
    const available = Math.min(now[src], onDate[src]);
    if (qty > available) {
      throw fail(`Only ${available} ${item.unit} available in ${src === 'shop' ? 'Shop' : 'Store'}.`);
    }
    const info = db.prepare(`INSERT INTO movements (request_id, item_id, direction, qty, movement_date, note, user,
      shop_before, store_before) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestId, item.id, data.direction, qty, date, note, user, now.shop, now.store);
    const after = balanceOf(item.id);
    db.prepare('UPDATE movements SET shop_after = ?, store_after = ? WHERE id = ?')
      .run(after.shop, after.store, info.lastInsertRowid);
    audit(user, 'movement.create', { id: info.lastInsertRowid, item: item.name, direction: data.direction, qty, date });
    return db.prepare('SELECT * FROM movements WHERE id = ?').get(info.lastInsertRowid);
  });
}

// ---------- daily counts (record only; never changes stock) ----------
function recordCount(data, user) {
  const date = checkDate(data.date || today());
  const physical = toInt(data.physical, 'Physical count', 0);
  const item = findItem(data.item_id ?? data.item);
  if (!item.active) throw fail(`"${item.name}" is inactive.`);
  const system = balanceOf(item.id, date).shop;
  const diff = physical - system;
  const status = diff === 0 ? 'MATCHED' : diff < 0 ? 'SHORT' : 'EXCESS';
  const key = `DISC:${item.id}:${date}`;

  transaction(() => {
    db.prepare(`INSERT INTO daily_counts (item_id, count_date, system_qty, physical_qty, difference, status, user)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id, count_date) DO UPDATE SET system_qty = excluded.system_qty,
        physical_qty = excluded.physical_qty, difference = excluded.difference,
        status = excluded.status, user = excluded.user, created_at = datetime('now')`)
      .run(item.id, date, system, physical, diff, status, user);
    if (status === 'MATCHED') {
      db.prepare(`UPDATE alerts SET status = 'CLEARED', resolved_at = datetime('now'),
        resolution = 'Recount matched' WHERE ref_key = ? AND status IN ('OPEN','ACKNOWLEDGED')`).run(key);
    } else {
      upsertAlert(key, 'DISCREPANCY', item.id, 'SHOP',
        `${item.name}: ${status} by ${Math.abs(diff)} ${item.unit} on ${date} (system ${system}, counted ${physical})`);
    }
    audit(user, 'count.save', { item: item.name, date, system, physical, diff, status });
  });
  return { item: item.name, date, system, physical, difference: diff, status };
}

function listCounts(date) {
  if (!isDate(date)) throw fail('Invalid date.');
  return db.prepare(`SELECT c.*, i.name AS item FROM daily_counts c JOIN items i ON i.id = c.item_id
    WHERE c.count_date = ?`).all(date);
}

// ---------- adjustments (explicit, reason required) ----------
function adjust(data, user) {
  const delta = Number(data.delta);
  if (!Number.isInteger(delta) || delta === 0) throw fail('Adjustment must be a whole number, not zero.');
  const location = String(data.location || '').toUpperCase();
  if (!['SHOP', 'STORE'].includes(location)) throw fail('Location must be SHOP or STORE.');
  const reason = String(data.reason || '').trim();
  if (reason.length < 3) throw fail('A reason is required (at least 3 characters).');
  const date = checkDate(data.date || today());
  const item = findItem(data.item_id ?? data.item);
  if (!item.active) throw fail(`"${item.name}" is inactive.`);
  const key = location === 'SHOP' ? 'shop' : 'store';

  return transaction(() => {
    const before = balanceOf(item.id)[key];
    const after = before + delta;
    if (after < 0) throw fail(`This adjustment would make ${location} negative (${after}).`);
    const info = db.prepare(`INSERT INTO adjustments (item_id, location, delta, reason, adj_date, user, before_qty, after_qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(item.id, location, delta, reason, date, user, before, after);
    audit(user, 'adjustment.create', { id: info.lastInsertRowid, item: item.name, location, delta, reason, date });
    return db.prepare('SELECT * FROM adjustments WHERE id = ?').get(info.lastInsertRowid);
  });
}

// ---------- monthly stock account ----------
function monthly(ym) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym || '')) throw fail('Month must be YYYY-MM.');
  const [y, m] = ym.split('-').map(Number);
  const start = `${ym}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const prevEnd = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);

  const opening = Object.fromEntries(balances(prevEnd).map((r) => [r.id, r]));
  const closing = balances(end);
  const mv = Object.fromEntries(db.prepare(`SELECT item_id,
      SUM(CASE WHEN direction = 'STORE_TO_SHOP' THEN qty ELSE 0 END) AS to_shop,
      SUM(CASE WHEN direction = 'SHOP_TO_STORE' THEN qty ELSE 0 END) AS to_store
    FROM movements WHERE movement_date BETWEEN ? AND ? GROUP BY item_id`).all(start, end)
    .map((r) => [r.item_id, r]));
  const ad = Object.fromEntries(db.prepare(`SELECT item_id,
      SUM(CASE WHEN location = 'SHOP' THEN delta ELSE 0 END) AS shop_adj,
      SUM(CASE WHEN location = 'STORE' THEN delta ELSE 0 END) AS store_adj
    FROM adjustments WHERE adj_date BETWEEN ? AND ? GROUP BY item_id`).all(start, end)
    .map((r) => [r.item_id, r]));

  const rows = closing.map((c) => {
    const o = opening[c.id] || { shop: 0, store: 0 };
    const m1 = mv[c.id] || {};
    const a = ad[c.id] || {};
    return {
      item_id: c.id, item: c.name, category: c.category, unit: c.unit, active: c.active ? 'yes' : 'no',
      open_shop: o.shop, open_store: o.store,
      to_shop: m1.to_shop || 0, to_store: m1.to_store || 0,
      adj_shop: a.shop_adj || 0, adj_store: a.store_adj || 0,
      close_shop: c.shop, close_store: c.store,
    };
  });
  const totals = { item: 'TOTAL' };
  for (const k of ['open_shop', 'open_store', 'to_shop', 'to_store', 'adj_shop', 'adj_store', 'close_shop', 'close_store']) {
    totals[k] = rows.reduce((s, r) => s + r[k], 0);
  }

  const weeks = [];
  const monthStart = new Date(`${start}T00:00:00Z`);
  const monthEnd = new Date(`${end}T00:00:00Z`);
  for (let weekIndex = 0; monthStart.getTime() + weekIndex * 7 * 86400000 <= monthEnd.getTime(); weekIndex++) {
    const weekStartDate = new Date(monthStart.getTime() + weekIndex * 7 * 86400000);
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setUTCDate(weekStartDate.getUTCDate() + 6);
    if (weekEndDate > monthEnd) weekEndDate.setTime(monthEnd.getTime());
    const weekStart = weekStartDate.toISOString().slice(0, 10);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);
    const usage = Object.fromEntries(db.prepare(`SELECT item_id,
      SUM(qty) AS items_used FROM movements
      WHERE movement_date BETWEEN ? AND ? AND direction = 'STORE_TO_SHOP'
      GROUP BY item_id`).all(weekStart, weekEnd).map((r) => [r.item_id, r.items_used || 0]));
    const items = closing.map((c) => ({
      item_id: c.id, item: c.name, unit: c.unit,
      store_stock: balances(weekEnd).find((r) => r.id === c.id).store,
      items_used: usage[c.id] || 0,
      shop_stock: balances(weekEnd).find((r) => r.id === c.id).shop,
    }));
    weeks.push({ week: weekIndex + 1, start: weekStart, end: weekEnd, items });
  }
  return { month: ym, start, end, rows, totals, weeks };
}

// ---------- alerts ----------
// Low/out alerts are derived from balances and clear automatically when stock recovers.
// Discrepancy alerts clear only on a matching recount or an explicit review.
function syncStockAlerts() {
  for (const r of balances()) {
    for (const [loc, key, min] of [['SHOP', 'shop', r.min_shop], ['STORE', 'store', r.min_store]]) {
      const bal = r[key];
      const ref = `STOCK:${loc}:${r.id}`;
      let kind = null;
      if (r.active) {
        if (min > 0 && bal <= 0) kind = 'OUT';
        else if (bal < min) kind = 'LOW';
      }
      if (kind) {
        upsertAlert(ref, kind, r.id, loc,
          `${r.name} is ${kind === 'OUT' ? 'out of stock' : 'low'} in ${loc === 'SHOP' ? 'Shop' : 'Store'}: ${bal} ${r.unit} (minimum ${min})`);
      } else {
        db.prepare(`UPDATE alerts SET status = 'CLEARED', resolved_at = datetime('now'),
          resolution = 'Auto-cleared: back above minimum' WHERE ref_key = ? AND status IN ('OPEN','ACKNOWLEDGED')`).run(ref);
      }
    }
  }
}

function listAlerts(status) {
  syncStockAlerts();
  const statuses = status && status !== 'ALL' ? [status] : ['OPEN', 'ACKNOWLEDGED'];
  return db.prepare(`SELECT a.*, i.name AS item_name FROM alerts a JOIN items i ON i.id = a.item_id
    WHERE a.status IN (${statuses.map(() => '?').join(',')})
    ORDER BY CASE a.status WHEN 'OPEN' THEN 0 ELSE 1 END, a.created_at DESC`).all(...statuses);
}

function reviewAlert(id, action, note, user) {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
  if (!a) throw fail('Alert not found.', 404);
  if (action === 'acknowledge') {
    db.prepare(`UPDATE alerts SET status = 'ACKNOWLEDGED', resolution = ? WHERE id = ?`)
      .run(note ? String(note).trim() : null, id);
  } else if (action === 'clear') {
    const n = String(note || '').trim();
    if (n.length < 3) throw fail('A short reason is required to clear an alert.');
    db.prepare(`UPDATE alerts SET status = 'CLEARED', resolved_at = datetime('now'), resolution = ? WHERE id = ?`)
      .run(n, id);
  } else {
    throw fail('Action must be acknowledge or clear.');
  }
  audit(user, `alert.${action}`, { id, note: note || null });
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

// ---------- dashboard ----------
function dashboard() {
  syncStockAlerts();
  const d = today();
  const active = balances().filter((r) => r.active);
  const counted = db.prepare(`SELECT COUNT(*) AS c FROM daily_counts c JOIN items i ON i.id = c.item_id
    WHERE c.count_date = ? AND i.active = 1`).get(d).c;
  const moves = db.prepare('SELECT COUNT(*) AS c FROM movements WHERE movement_date = ?').get(d).c;
  const alerts = Object.fromEntries(db.prepare(`SELECT kind, COUNT(*) AS c FROM alerts
    WHERE status IN ('OPEN','ACKNOWLEDGED') GROUP BY kind`).all().map((r) => [r.kind, r.c]));
  const recent = db.prepare(`SELECT m.movement_date, i.name AS item, m.direction, m.qty, m.note, m.user
    FROM movements m JOIN items i ON i.id = m.item_id ORDER BY m.id DESC LIMIT 8`).all();
  return {
    date: d,
    active_items: active.length,
    shop_total: active.reduce((s, r) => s + r.shop, 0),
    store_total: active.reduce((s, r) => s + r.store, 0),
    moves_today: moves,
    count: { counted, total: active.length },
    alerts,
    recent,
  };
}

// ---------- reports ----------
function range(q = {}) {
  const now = today();
  const from = isDate(q.from) ? q.from : now.slice(0, 8) + '01';
  const to = isDate(q.to) ? q.to : now;
  if (from > to) throw fail('"From" date must be before "To" date.');
  return { from, to };
}

function summary(period, anchor = today()) {
  const p = String(period || 'month').toLowerCase();
  if (!['week', 'month', 'quarter'].includes(p)) throw fail('Period must be week, month or quarter.');
  checkDate(anchor);
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  let from, to;
  if (p === 'week') {
    const day = anchorDate.getUTCDay();
    const offset = day === 0 ? -6 : 1 - day;
    const start = new Date(anchorDate);
    start.setUTCDate(anchorDate.getUTCDate() + offset);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    from = start.toISOString().slice(0, 10);
    to = end.toISOString().slice(0, 10);
  } else if (p === 'month') {
    const year = anchorDate.getUTCFullYear();
    const month = anchorDate.getUTCMonth() + 1;
    from = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = new Date(Date.UTC(year, month, 0));
    to = end.toISOString().slice(0, 10);
  } else {
    const year = anchorDate.getUTCFullYear();
    const quarter = Math.floor(anchorDate.getUTCMonth() / 3);
    const startMonth = quarter * 3;
    from = `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
    const end = new Date(Date.UTC(year, startMonth + 3, 0));
    to = end.toISOString().slice(0, 10);
  }
  const movements = db.prepare(`SELECT m.movement_date AS date, i.name AS item, m.direction, m.qty,
    m.shop_before, m.shop_after, m.store_before, m.store_after, m.note, m.user
    FROM movements m JOIN items i ON i.id = m.item_id
    WHERE m.movement_date BETWEEN ? AND ? ORDER BY m.movement_date, m.id`).all(from, to);
  const adjustments = db.prepare(`SELECT a.adj_date AS date, i.name AS item, a.location, a.delta,
    a.reason, a.user, a.before_qty, a.after_qty
    FROM adjustments a JOIN items i ON i.id = a.item_id
    WHERE a.adj_date BETWEEN ? AND ? ORDER BY a.adj_date, a.id`).all(from, to);
  const counts = db.prepare(`SELECT c.count_date AS date, i.name AS item, c.system_qty,
    c.physical_qty, c.difference, c.status, c.user
    FROM daily_counts c JOIN items i ON i.id = c.item_id
    WHERE c.count_date BETWEEN ? AND ? ORDER BY c.count_date, i.name`).all(from, to);
  return {
    period: p, anchor, range: { from, to },
    movements, adjustments, counts,
    balances: balances(to).filter((r) => r.active).map((r) => ({
      item: r.name, category: r.category, unit: r.unit, shop: r.shop, store: r.store,
      min_shop: r.min_shop, min_store: r.min_store,
    })),
  };
}

function report(type, q = {}) {
  if (type === 'balances') {
    const loc = q.loc === 'STORE' ? 'store' : 'shop';
    const asOf = isDate(q.asOf) ? q.asOf : null;
    return balances(asOf).filter((r) => r.active).map((r) => {
      const min = loc === 'shop' ? r.min_shop : r.min_store;
      return {
        item: r.name, category: r.category, unit: r.unit, quantity: r[loc], minimum: min,
        status: r[loc] <= 0 && min > 0 ? 'OUT' : r[loc] < min ? 'LOW' : 'OK',
      };
    });
  }
  if (type === 'daily-shop') {
    const date = checkDate(q.date || today());
    const counts = Object.fromEntries(listCounts(date).map((c) => [c.item_id, c]));
    return balances(date).filter((r) => r.active).map((r) => {
      const c = counts[r.id];
      return {
        item: r.name, category: r.category, unit: r.unit, system_shop: r.shop,
        counted: c ? c.physical_qty : '', difference: c ? c.difference : '',
        status: c ? c.status : 'NOT COUNTED',
      };
    });
  }
  const { from, to } = range(q);
  if (type === 'movements') {
    return db.prepare(`SELECT m.movement_date AS date, i.name AS item, m.direction, m.qty,
        m.shop_before, m.shop_after, m.store_before, m.store_after, m.note, m.user
      FROM movements m JOIN items i ON i.id = m.item_id
      WHERE m.movement_date BETWEEN ? AND ? ORDER BY m.movement_date, m.id`).all(from, to);
  }
  if (type === 'low-stock') {
    syncStockAlerts();
    return db.prepare(`SELECT a.kind, a.location, i.name AS item, a.message, a.status, a.created_at
      FROM alerts a JOIN items i ON i.id = a.item_id
      WHERE a.kind IN ('LOW','OUT') AND a.status <> 'CLEARED' ORDER BY a.kind, i.name`).all();
  }
  if (type === 'discrepancies') {
    return db.prepare(`SELECT c.count_date AS date, i.name AS item, c.system_qty, c.physical_qty,
        c.difference, c.status, c.user
      FROM daily_counts c JOIN items i ON i.id = c.item_id
      WHERE c.status <> 'MATCHED' AND c.count_date BETWEEN ? AND ? ORDER BY c.count_date DESC, i.name`).all(from, to);
  }
  if (type === 'monthly') return monthly(q.month).rows;
  throw fail('Unknown report.', 404);
}

function toCsv(rows) {
  if (!rows || !rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

module.exports = {
  DB_PATH, isDate, today, fail,
  balances, balanceOf, findItem,
  listItems, createItem, updateItem,
  transfer, recordCount, listCounts, adjust,
  monthly, syncStockAlerts, listAlerts, reviewAlert,
  dashboard, summary, report, toCsv,
};
