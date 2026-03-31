/**
 * Cloudflare Worker for quarryme.com
 * Serves static assets only — all MSHA data is pre-embedded in index.html.
 */

export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
