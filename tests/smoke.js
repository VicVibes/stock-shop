// Run: npm test   (uses a temporary database)
const path = require('path');
const os = require('os');
process.env.DB_PATH = path.join(os.tmpdir(), `stock-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
const assert = require('assert');
const { seed } = require('../src/db');
const s = require('../src/stock');

seed();
const U = 'test';
const oldItems = ['Bottled Water 500ml', 'Soft Drink 330ml', 'Biscuit Pack', 'Tissue Roll', 'Dish Soap 500ml', 'Sugar 1kg'];
assert.ok(oldItems.every((name) => !s.listItems(1).some((item) => item.name === name)));
assert.strictEqual(s.listItems(1).length, 17);
const item = s.findItem('Paper (6 cartons + rims)');
const start = s.balanceOf(item.id);
assert.strictEqual(start.shop, 6);
assert.strictEqual(start.store, 0);

// 1. Valid transfer moves both sides together.
s.transfer({ item_id: item.id, direction: 'SHOP_TO_STORE', qty: 5, request_id: 'r1' }, U);
let b = s.balanceOf(item.id);
assert.strictEqual(b.shop, 1);
assert.strictEqual(b.store, 5);

// 2. Duplicate submission with same request id is blocked.
const dup = s.transfer({ item_id: item.id, direction: 'SHOP_TO_STORE', qty: 5, request_id: 'r1' }, U);
assert.strictEqual(dup.duplicate, true);
assert.strictEqual(s.balanceOf(item.id).shop, 1);

// 3. Overdraft rejected, nothing changes.
assert.throws(() => s.transfer({ item_id: item.id, direction: 'SHOP_TO_STORE', qty: 999 }, U), /Only/);
assert.strictEqual(s.balanceOf(item.id).shop, 1);

// 4. Zero, invalid date, future date rejected.
assert.throws(() => s.transfer({ item_id: item.id, direction: 'SHOP_TO_STORE', qty: 0 }, U));
assert.throws(() => s.transfer({ item_id: item.id, direction: 'SHOP_TO_STORE', qty: 1, date: '2024-02-30' }, U), /Invalid date/);
assert.throws(() => s.transfer({ item_id: item.id, direction: 'SHOP_TO_STORE', qty: 1, date: '2999-01-01' }, U), /future/);

// 5. Daily count records difference but does NOT change stock.
const c = s.recordCount({ item_id: item.id, physical: 0, date: s.today() }, U);
assert.strictEqual(c.status, 'SHORT');
assert.strictEqual(c.difference, -1);
assert.strictEqual(s.balanceOf(item.id).shop, 1);

// 6. Adjustment requires reason and changes stock.
assert.throws(() => s.adjust({ item_id: item.id, location: 'SHOP', delta: -7, reason: '' }, U), /reason/);
s.adjust({ item_id: item.id, location: 'SHOP', delta: 7, reason: 'Count confirmed short', date: s.today() }, U);
assert.strictEqual(s.balanceOf(item.id).shop, 8);

// 7. Inactive items cannot move, but history remains.
s.updateItem(item.id, { active: false }, U);
assert.throws(() => s.transfer({ item_id: item.id, direction: 'STORE_TO_SHOP', qty: 1 }, U), /inactive/);
s.updateItem(item.id, { active: true }, U);

// 8. Monthly account reconciles: close = open + to_shop - to_store + adj.
const ym = s.today().slice(0, 7);
const m = s.monthly(ym);
const row = m.rows.find((r) => r.item_id === item.id);
assert.strictEqual(row.close_shop, row.open_shop + row.to_shop - row.to_store + row.adj_shop);
assert.strictEqual(row.close_store, row.open_store - row.to_shop + row.to_store + row.adj_store);
assert.strictEqual(row.close_shop, s.balanceOf(item.id).shop);

// 9. Monthly stock is grouped into weekly Store stock, items used, and Shop stock.
assert.ok(Array.isArray(m.weeks) && m.weeks.length > 0);
const week = m.weeks[0];
assert.ok(week.items.every((r) => Number.isFinite(r.store_stock) && Number.isFinite(r.items_used) && Number.isFinite(r.shop_stock)));
assert.ok(week.items.some((r) => r.item === item.name));

// 10. Read-only period summaries can be generated for week, month and quarter.
const summary = s.summary('week', s.today());
assert.strictEqual(summary.period, 'week');
assert.ok(summary.range.from && summary.range.to);
assert.ok(Array.isArray(summary.movements));
assert.ok(Array.isArray(summary.adjustments));
assert.ok(Array.isArray(summary.counts));
assert.ok(summary.balances.every((r) => !('recordCount' in r)));

// 11. Low-stock alert is raised for Shop, then clears when stock recovers.
s.syncStockAlerts();
const paper = s.findItem('Paper (6 cartons + rims)');
s.transfer({ item_id: paper.id, direction: 'SHOP_TO_STORE', qty: 5 }, U); // Shop 8 -> 3, above minimum.
s.syncStockAlerts();
const before = s.listAlerts().find((a) => a.item_id === paper.id && a.location === 'SHOP' && a.kind === 'LOW');
assert.ok(!before, 'this paper item should not generate a low-stock alert after the transfer');
s.transfer({ item_id: paper.id, direction: 'STORE_TO_SHOP', qty: 5 }, U); // Shop 3 -> 8
s.syncStockAlerts();
assert.ok(!s.listAlerts().find((a) => a.item_id === paper.id && a.location === 'SHOP' && a.kind === 'LOW'), 'low-stock alert should remain clear');

console.log('All smoke tests passed.');
