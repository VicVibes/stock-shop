/**
 * Cloudflare entrypoint placeholder.
 *
 * The existing Express API is intentionally kept in src/ while the API is
 * ported to D1. This entrypoint serves the frontend and provides a clear
 * deployment-time response until the route handlers are migrated.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/status') {
      return Response.json({
        ok: true,
        platform: 'cloudflare',
        database: Boolean(env.DB),
        ai: Boolean(env.AI || env.GOOGLE_API_KEY),
        message: 'Cloudflare deployment scaffold is active; API migration is in progress.'
      });
    }
    return env.ASSETS.fetch(request);
  }
};
