/**
 * Cloudflare Worker for quarryme.com
 * Proxies MSHA / DOL API requests to avoid browser CORS restrictions.
 *
 * Routes:
 *   GET /api/msha/:mineId             -> DOL Mines endpoint
 *   GET /api/msha/:mineId/violations  -> DOL Violations endpoint
 *   GET /api/msha/:mineId/inspections -> DOL Inspections endpoint
 *   GET /api/msha/:mineId/production  -> DOL MineAnnualProductionInfo endpoint
 *   everything else -> static assets
 *
 * Optional env var: DOL_API_KEY — set as a Cloudflare Workers secret if needed.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname.startsWith('/api/msha/')) {
      return proxyMsha(url, env);
    }

    // Fall through to static assets
    return env.ASSETS.fetch(request);
  },
};

async function proxyMsha(url, env) {
  // pathname: /api/msha/{mineId}[/sub]
  const after = url.pathname.slice('/api/msha/'.length); // e.g. "0200032" or "0200032/violations"
  const slash = after.indexOf('/');
  const mineId = slash === -1 ? after : after.slice(0, slash);
  const sub = slash === -1 ? '' : after.slice(slash + 1); // 'violations' | 'inspections' | 'production' | ''

  if (!mineId) {
    return jsonResp({ error: 'Missing mine ID' }, 400);
  }

  const dolHeaders = {};
  if (env.DOL_API_KEY) {
    dolHeaders['X-API-KEY'] = env.DOL_API_KEY;
  }

  const enc = encodeURIComponent(`MINE_ID eq '${mineId}'`);
  let apiUrl;

  switch (sub) {
    case 'violations':
      apiUrl = `https://api.dol.gov/V2/Mining/Violations?filter=${enc}&$top=100&$orderby=VIOLATION_OCCUR_DT%20desc`;
      break;
    case 'inspections':
      apiUrl = `https://api.dol.gov/V2/Mining/Inspections?filter=${enc}&$top=1&$orderby=INSPECTION_END_DT%20desc`;
      break;
    case 'production':
      apiUrl = `https://api.dol.gov/V2/Mining/MineAnnualProductionInfo?filter=${enc}&$top=5&$orderby=CAL_YR%20desc`;
      break;
    default:
      apiUrl = `https://api.dol.gov/V2/Mining/Mines?filter=${enc}`;
  }

  try {
    const resp = await fetch(apiUrl, { headers: dolHeaders });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (e) {
    return jsonResp({ error: e.message }, 502);
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
