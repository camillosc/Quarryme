/**
 * Cloudflare Worker for quarryme.com
 * Proxies MSHA requests by scraping arlweb.msha.gov (no API key required).
 *
 * Routes:
 *   GET /api/msha/:mineId             -> scrape BasicMineInfoResults.asp
 *   GET /api/msha/:mineId/violations  -> returns empty array (placeholder)
 *   GET /api/msha/:mineId/inspections -> returns empty array (placeholder)
 *   GET /api/msha/:mineId/production  -> returns empty array (placeholder)
 *   everything else -> static assets
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname.startsWith('/api/msha/')) {
      return handleMsha(url, env);
    }

    // Fall through to static assets
    return env.ASSETS.fetch(request);
  },
};

async function handleMsha(url, env) {
  // pathname: /api/msha/{mineId}[/sub]
  const after = url.pathname.slice('/api/msha/'.length);
  const slash = after.indexOf('/');
  const mineId = slash === -1 ? after : after.slice(0, slash);
  const sub = slash === -1 ? '' : after.slice(slash + 1);

  if (!mineId) {
    return jsonResp({ error: 'Missing mine ID' }, 400);
  }

  // Placeholder routes
  if (sub === 'violations' || sub === 'inspections' || sub === 'production') {
    return jsonResp({ value: [] });
  }

  // Main mine info: scrape arlweb.msha.gov
  try {
    const scrapeUrl = `https://arlweb.msha.gov/drs/ASP/BasicMineInfoResults.asp?MineId=${encodeURIComponent(mineId)}`;
    const resp = await fetch(scrapeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; quarryme-proxy/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!resp.ok) {
      return jsonResp({ error: `Upstream returned ${resp.status}` }, 502);
    }

    const html = await resp.text();
    const mineInfo = parseMineInfoHtml(html);

    return jsonResp({ value: [mineInfo] });
  } catch (e) {
    return jsonResp({ error: e.message }, 502);
  }
}

/**
 * Parse the BasicMineInfoResults.asp HTML page.
 * The page contains a table with rows of label/value pairs.
 */
function parseMineInfoHtml(html) {
  const info = {};

  // Extract all table cells — the page uses a simple two-column label/value layout
  // Pattern: <td ...>Label</td><td ...>Value</td>
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells = [];
    let cellMatch;
    const localCellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((cellMatch = localCellPattern.exec(rowHtml)) !== null) {
      cells.push(stripHtml(cellMatch[1]).trim());
    }
    if (cells.length >= 2 && cells[0]) {
      const key = labelToKey(cells[0]);
      if (key) {
        info[key] = cells[1] || '';
      }
    }
  }

  return info;
}

/** Strip HTML tags and decode basic entities */
function stripHtml(str) {
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convert a human-readable label to a SCREAMING_SNAKE_CASE key */
function labelToKey(label) {
  const cleaned = label.replace(/[^A-Za-z0-9 ]/g, '').trim();
  if (!cleaned) return null;
  return cleaned.toUpperCase().replace(/\s+/g, '_');
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
