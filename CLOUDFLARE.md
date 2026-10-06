# Cloudflare deployment

The local app currently runs with Node.js and a local SQLite file. The
Cloudflare version uses Workers Static Assets for the frontend, a Worker for
the API, and D1 for persistent SQL data.

## Initial setup

```powershell
npm install -D wrangler
npx wrangler login
npx wrangler d1 create stock-shop
```

Copy the returned database ID into `wrangler.jsonc`, then apply the schema:

```powershell
npx wrangler d1 migrations apply stock-shop --remote
npx wrangler deploy
```

Do not upload `data/stock.db` to Git. It remains a local backup and will be
converted/imported separately after the D1 schema is deployed.

## Current status

The Cloudflare deployment scaffold is in place. The existing Express API in
`src/` still powers local development. The next migration step is porting the
stock service functions and `/api/*` routes to D1-backed Worker handlers, then
connecting the existing frontend to those routes.
