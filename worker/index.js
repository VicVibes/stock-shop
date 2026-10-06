const json = (body, status = 200) => Response.json(body, { status });

const today = () => new Date().toISOString().slice(0, 10);

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
  return null;
}

export default {
  async fetch(request, env) {
    const response = await route(request, env);
    if (response) return response;
    return env.ASSETS.fetch(request);
  }
};
