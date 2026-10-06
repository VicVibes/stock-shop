const json = (body, status = 200) => Response.json(body, { status });

const today = () => new Date().toISOString().slice(0, 10);

async function body(request) { return request.json().catch(() => ({})); }
async function itemBy(db, ref) {
  const key = String(ref ?? '').trim();
  if (!key) throw new Error('Item is required.');
  const row = await db.prepare('SELECT * FROM items WHERE id = ? OR name = ? COLLATE NOCASE').bind(Number(key) || -1, key).first();
  if (!row) throw new Error('Item not found.');
  return row;
}
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }

async function balances(db, asOf = null) {
  const end = asOf || today();
  const { results } = await db.prepare(`
    SELECT i.*, i.opening_shop + COALESCE((SELECT SUM(CASE WHEN direction='STORE_TO_SHOP' THEN qty ELSE -qty END) FROM movements WHERE item_id=i.id AND movement_date<=?), 0) + COALESCE((SELECT SUM(CASE WHEN location='SHOP' THEN delta ELSE 0 END) FROM adjustments WHERE item_id=i.id AND adj_date<=?), 0) AS shop,
    i.opening_store + COALESCE((SELECT SUM(CASE WHEN direction='SHOP_TO_STORE' THEN qty ELSE -qty END) FROM movements WHERE item_id=i.id AND movement_date<=?), 0) + COALESCE((SELECT SUM(CASE WHEN location='STORE' THEN delta ELSE 0 END) FROM adjustments WHERE item_id=i.id AND adj_date<=?), 0) AS store
    FROM items i ORDER BY i.name`)
    .bind(end, end, end, end).all();
  return results;
}

async function route(request, env) {
  const url = new URL(request.url);
  const method = request.method;
  if (url.pathname === '/api/status' && method === 'GET') {
    return json({ user: env.STOCK_USER || 'Storekeeper', ai: Boolean(env.AI || env.GOOGLE_API_KEY), aiProvider: env.AI ? 'cloudflare' : 'google', db: 'D1' });
  }
  if (url.pathname === '/api/balances' && method === 'GET') return json(await balances(env.DB, url.searchParams.get('asOf')));
  if (url.pathname === '/api/items' && method === 'GET') {
    const all = url.searchParams.get('all') === '1';
    const q = all ? 'SELECT * FROM items ORDER BY name' : 'SELECT * FROM items WHERE active=1 ORDER BY name';
    return json((await env.DB.prepare(q).all()).results);
  }
  if (url.pathname === '/api/dashboard' && method === 'GET') {
    const rows = await balances(env.DB);
    const alerts = (await env.DB.prepare("SELECT COUNT(*) AS c FROM alerts WHERE status='OPEN'").first()).c;
    return json({ items: rows.filter((r) => r.active).length, shop_units: rows.reduce((n, r) => n + r.shop, 0), store_units: rows.reduce((n, r) => n + r.store, 0), open_alerts: alerts });
  }
  if (url.pathname === '/api/movements' && method === 'POST') {
    const a = await body(request); const qty = Number(a.qty); const direction = a.direction;
    if (!Number.isInteger(qty) || qty < 1) fail('Quantity must be a positive whole number.');
    if (!['STORE_TO_SHOP', 'SHOP_TO_STORE'].includes(direction)) fail('Invalid transfer direction.');
    const item = await itemBy(env.DB, a.item_id ?? a.item); if (!item.active) fail('Item is inactive.');
    const current = (await balances(env.DB)).find((r) => r.id === item.id);
    const source = direction === 'STORE_TO_SHOP' ? current.store : current.shop;
    if (qty > source) fail(`Only ${source} ${item.unit} available.`);
    const date = a.date || today(); const user = env.STOCK_USER || 'Storekeeper';
    const result = await env.DB.batch([
      env.DB.prepare(`INSERT INTO movements (request_id,item_id,direction,qty,movement_date,note,user,shop_before,store_before) VALUES (?,?,?,?,?,?,?,?,?)`).bind(a.request_id || null, item.id, direction, qty, date, String(a.note || '').slice(0, 200) || null, user, current.shop, current.store),
      env.DB.prepare(`INSERT INTO audit_log (user,action,details) VALUES (?,?,?)`).bind(user, 'movement.create', JSON.stringify({ item: item.name, direction, qty, date }))
    ]);
    if (!result) fail('Transfer failed.', 500);
    return json({ ok: true, item: item.name, direction, qty, date, balances: await balances(env.DB) });
  }
  if (url.pathname === '/api/adjustments' && method === 'POST') {
    const a = await body(request); const delta = Number(a.delta); const location = String(a.location || '').toUpperCase();
    if (!Number.isInteger(delta) || delta === 0) fail('Adjustment must be a non-zero whole number.');
    if (!['SHOP', 'STORE'].includes(location)) fail('Invalid location.');
    if (String(a.reason || '').trim().length < 3) fail('A reason is required.');
    const item = await itemBy(env.DB, a.item_id ?? a.item); if (!item.active) fail('Item is inactive.');
    const current = (await balances(env.DB)).find((r) => r.id === item.id); const key = location === 'SHOP' ? 'shop' : 'store';
    if (current[key] + delta < 0) fail('This adjustment would make the balance negative.');
    const user = env.STOCK_USER || 'Storekeeper';
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO adjustments (item_id,location,delta,reason,adj_date,user,before_qty,after_qty) VALUES (?,?,?,?,?,?,?,?)`).bind(item.id, location, delta, String(a.reason).trim(), a.date || today(), user, current[key], current[key] + delta),
      env.DB.prepare(`INSERT INTO audit_log (user,action,details) VALUES (?,?,?)`).bind(user, 'adjustment.create', JSON.stringify(a))
    ]);
    return json({ ok: true, item: item.name, location, delta, balances: await balances(env.DB) });
  }
  if (url.pathname === '/api/counts' && method === 'POST') {
    const a = await body(request); const date = a.date || today(); const lines = Array.isArray(a.lines) ? a.lines : [];
    if (!lines.length) fail('No counts to save.');
    const user = env.STOCK_USER || 'Storekeeper'; const results = [];
    for (const line of lines) {
      const item = await itemBy(env.DB, line.item_id ?? line.item); const current = (await balances(env.DB)).find((r) => r.id === item.id); const physical = Number(line.physical); 
      if (!Number.isInteger(physical) || physical < 0) { results.push({ item: item.name, error: 'Invalid physical count.' }); continue; }
      const difference = physical - current.shop; const status = difference === 0 ? 'MATCHED' : difference < 0 ? 'SHORT' : 'EXCESS';
      await env.DB.prepare(`INSERT INTO daily_counts (item_id,count_date,system_qty,physical_qty,difference,status,user) VALUES (?,?,?,?,?,?,?) ON CONFLICT(item_id,count_date) DO UPDATE SET system_qty=excluded.system_qty,physical_qty=excluded.physical_qty,difference=excluded.difference,status=excluded.status,user=excluded.user`).bind(item.id, date, current.shop, physical, difference, status, user).run();
      results.push({ item: item.name, date, system: current.shop, physical, difference, status });
    }
    return json({ results });
  }
  return null;
}

export default {
  async fetch(request, env) {
    try { const response = await route(request, env); if (response) return response; }
    catch (e) { return json({ error: e.message || 'Request failed.' }, e.status || 500); }
    return env.ASSETS.fetch(request);
  }
};
