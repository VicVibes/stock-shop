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
  if (url.pathname === '/api/items' && method === 'POST') {
    const a = await body(request); const name = String(a.name || '').trim(); if (!name) fail('Item name is required.');
    try {
      const result = await env.DB.prepare(`INSERT INTO items (name,category,unit,min_shop,min_store,opening_shop,opening_store) VALUES (?,?,?,?,?,?,?) RETURNING *`).bind(name, String(a.category || 'General'), String(a.unit || 'pcs'), Number(a.min_shop || 0), Number(a.min_store || 0), Number(a.opening_shop || 0), Number(a.opening_store || 0)).first();
      return json(result, 201);
    } catch (e) { if (String(e.message).includes('UNIQUE')) fail('An item with that name already exists.', 409); throw e; }
  }
  const itemMatch = url.pathname.match(/^\/api\/items\/(\d+)$/);
  if (itemMatch && method === 'PATCH') {
    const a = await body(request); const id = Number(itemMatch[1]); const old = await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first(); if (!old) fail('Item not found.', 404);
    const next = { name: a.name ?? old.name, category: a.category ?? old.category, unit: a.unit ?? old.unit, min_shop: a.min_shop ?? old.min_shop, min_store: a.min_store ?? old.min_store, opening_shop: a.opening_shop ?? old.opening_shop, opening_store: a.opening_store ?? old.opening_store, active: a.active === undefined ? old.active : (a.active ? 1 : 0) };
    const result = await env.DB.prepare(`UPDATE items SET name=?,category=?,unit=?,min_shop=?,min_store=?,opening_shop=?,opening_store=?,active=? WHERE id=? RETURNING *`).bind(next.name,next.category,next.unit,next.min_shop,next.min_store,next.opening_shop,next.opening_store,next.active,id).first();
    return json(result);
  }
  if (url.pathname === '/api/dashboard' && method === 'GET') {
    const rows = await balances(env.DB);
    const active = rows.filter((r) => r.active); const day = today();
    const counted = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM daily_counts c JOIN items i ON i.id=c.item_id WHERE c.count_date=? AND i.active=1`).bind(day).first()).c;
    const moves = (await env.DB.prepare('SELECT COUNT(*) AS c FROM movements WHERE movement_date=?').bind(day).first()).c;
    const alertRows = (await env.DB.prepare(`SELECT kind,COUNT(*) AS c FROM alerts WHERE status IN ('OPEN','ACKNOWLEDGED') GROUP BY kind`).all()).results;
    const alerts = Object.fromEntries(alertRows.map((r) => [r.kind, r.c]));
    const recent = (await env.DB.prepare(`SELECT m.movement_date,i.name AS item,m.direction,m.qty,m.note,m.user FROM movements m JOIN items i ON i.id=m.item_id ORDER BY m.id DESC LIMIT 8`).all()).results;
    return json({ date: day, active_items: active.length, shop_total: active.reduce((n, r) => n + r.shop, 0), store_total: active.reduce((n, r) => n + r.store, 0), moves_today: moves, count: { counted, total: active.length }, alerts, recent });
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
  if (url.pathname === '/api/counts' && method === 'GET') {
    const date = url.searchParams.get('date') || today();
    return json((await env.DB.prepare(`SELECT c.*,i.name AS item FROM daily_counts c JOIN items i ON i.id=c.item_id WHERE c.count_date=?`).bind(date).all()).results);
  }
  if (url.pathname === '/api/monthly' && method === 'GET') {
    const ym = url.searchParams.get('month') || today().slice(0, 7); const start = `${ym}-01`; const [year, month] = ym.split('-').map(Number); const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0,10); const prev = new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0,10);
    const close = await balances(env.DB, end); const open = await balances(env.DB, prev); const movements = (await env.DB.prepare(`SELECT item_id,SUM(CASE WHEN direction='STORE_TO_SHOP' THEN qty ELSE 0 END) to_shop,SUM(CASE WHEN direction='SHOP_TO_STORE' THEN qty ELSE 0 END) to_store FROM movements WHERE movement_date BETWEEN ? AND ? GROUP BY item_id`).bind(start,end).all()).results; const adjustments = (await env.DB.prepare(`SELECT item_id,SUM(CASE WHEN location='SHOP' THEN delta ELSE 0 END) adj_shop,SUM(CASE WHEN location='STORE' THEN delta ELSE 0 END) adj_store FROM adjustments WHERE adj_date BETWEEN ? AND ? GROUP BY item_id`).bind(start,end).all()).results;
    const rows = close.map((c) => { const o=open.find((x)=>x.id===c.id)||{}; const m=movements.find((x)=>x.item_id===c.id)||{}; const a=adjustments.find((x)=>x.item_id===c.id)||{}; return { item_id:c.id,item:c.name,category:c.category,unit:c.unit,open_shop:o.shop||0,open_store:o.store||0,to_shop:m.to_shop||0,to_store:m.to_store||0,adj_shop:a.adj_shop||0,adj_store:a.adj_store||0,close_shop:c.shop,close_store:c.store }; });
    return json({ month: ym, start, end, rows, totals: { item:'TOTAL', close_shop:rows.reduce((n,r)=>n+r.close_shop,0), close_store:rows.reduce((n,r)=>n+r.close_store,0) }, weeks: [] });
  }
  if (url.pathname === '/api/history' && method === 'GET') {
    const date = url.searchParams.get('date') || today(); const from = `${date.slice(0,7)}-01`;
    const balancesNow = await balances(env.DB); const movements = (await env.DB.prepare(`SELECT m.movement_date AS date,i.name AS item,m.direction,m.qty,m.note,m.user FROM movements m JOIN items i ON i.id=m.item_id WHERE m.movement_date BETWEEN ? AND ? ORDER BY m.id DESC`).bind(from,date).all()).results;
    const adjustments = (await env.DB.prepare(`SELECT a.adj_date AS date,i.name AS item,a.location,a.delta,a.reason,a.user FROM adjustments a JOIN items i ON i.id=a.item_id WHERE a.adj_date BETWEEN ? AND ? ORDER BY a.id DESC`).bind(from,date).all()).results;
    const counts = (await env.DB.prepare(`SELECT c.count_date AS date,i.name AS item,c.system_qty,c.physical_qty,c.difference,c.status,c.user FROM daily_counts c JOIN items i ON i.id=c.item_id WHERE c.count_date BETWEEN ? AND ? ORDER BY c.id DESC`).bind(from,date).all()).results;
    return json({ range:{from,to:date}, balances:balancesNow, movements, adjustments, counts });
  }
  if (url.pathname === '/api/alerts' && method === 'GET') {
    const status = url.searchParams.get('status'); const q = status ? 'SELECT a.*,i.name AS item FROM alerts a JOIN items i ON i.id=a.item_id WHERE a.status=? ORDER BY a.id DESC' : 'SELECT a.*,i.name AS item FROM alerts a JOIN items i ON i.id=a.item_id WHERE a.status IN (\'OPEN\',\'ACKNOWLEDGED\') ORDER BY a.id DESC';
    return json((await env.DB.prepare(q).bind(...(status ? [status] : [])).all()).results);
  }
  const alertMatch = url.pathname.match(/^\/api\/alerts\/(\d+)\/review$/);
  if (alertMatch && method === 'POST') {
    const a = await body(request); if (!['acknowledge','clear'].includes(a.action)) fail('Invalid alert action.');
    const status = a.action === 'clear' ? 'CLEARED' : 'ACKNOWLEDGED'; const result = await env.DB.prepare(`UPDATE alerts SET status=?,resolved_at=CASE WHEN ?='CLEARED' THEN datetime('now') ELSE resolved_at END,resolution=? WHERE id=? RETURNING *`).bind(status,status,String(a.note || a.action),Number(alertMatch[1])).first();
    if (!result) fail('Alert not found.', 404); return json(result);
  }
  if (url.pathname.startsWith('/api/reports/') && method === 'GET') {
    const type = url.pathname.split('/').pop();
    if (type === 'balances') return json(await balances(env.DB, url.searchParams.get('date')));
    if (type === 'movements') return json((await env.DB.prepare(`SELECT m.*,i.name AS item FROM movements m JOIN items i ON i.id=m.item_id ORDER BY m.movement_date DESC,m.id DESC`).all()).results);
    if (type === 'discrepancies') return json((await env.DB.prepare(`SELECT c.*,i.name AS item FROM daily_counts c JOIN items i ON i.id=c.item_id WHERE c.status <> 'MATCHED' ORDER BY c.count_date DESC`).all()).results);
    if (type === 'low-stock') return json((await balances(env.DB)).filter((r) => (r.shop < r.min_shop) || (r.store < r.min_store)));
    return json([]);
  }
  if (url.pathname === '/api/assistant' && method === 'POST') {
    if (!env.GOOGLE_API_KEY && !env.AI) fail('Assistant is not configured.', 503);
    const a = await body(request); const prompt = String(a.message || '').trim(); if (!prompt) fail('Type a message first.');
    if (env.AI) { const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { prompt: `You are the stock assistant. Current stock data: ${JSON.stringify(await balances(env.DB))}\nUser: ${prompt}` }); return json({ reply: out.response || String(out), actions: [] }); }
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(env.GOOGLE_API_KEY)}`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ contents:[{role:'user',parts:[{text:prompt}]}]}) });
    const data = await resp.json(); return json({ reply: data.candidates?.[0]?.content?.parts?.map((p)=>p.text||'').join('') || 'No response.', actions: [] });
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
