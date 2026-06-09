/**
 * Cloudflare Worker for quarryme.com
 *
 * Routes:
 *   /union-club/*                     -> HTTP Basic Auth gate (password-protected)
 *   /api/msha/:mineId                 -> Mine info (arlweb.msha.gov HTML scrape)
 *   /api/msha/:mineId/violations      -> Violations (arlweb.msha.gov HTML scrape)
 *   /api/msha/:mineId/inspections     -> Inspections (arlweb.msha.gov HTML scrape)
 *   /api/msha/:mineId/production      -> Annual production (arlweb.msha.gov HTML scrape)
 *   everything else                   -> static assets
 */

// Password gate for /union-club/* — accepts any username, password must match
const UNION_CLUB_PASSWORD = 'natalia';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Password-gate the entire Union Club tree, including sub-pages such as
    // /union-club/dinner-2026-06-08/. Matches both the bare /union-club path
    // (served as union-club.html) and any /union-club/... descendant.
    if (url.pathname === '/union-club' ||
        url.pathname === '/union-club.html' ||
        url.pathname.startsWith('/union-club/')) {
      const authResp = checkBasicAuth(request);
      if (authResp) return authResp;
    }

    if (url.pathname.startsWith('/api/msha/')) {
      return proxyMsha(url, env, request);
    }

    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------------
// HTTP Basic Auth gate
// ---------------------------------------------------------------------------
function checkBasicAuth(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const idx = decoded.indexOf(':');
      const password = idx >= 0 ? decoded.slice(idx + 1) : '';
      if (password === UNION_CLUB_PASSWORD) {
        return null; // authorized — let the request through
      }
    } catch (_) {
      // fall through to 401
    }
  }
  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Union Club", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function proxyMsha(url, env, request) {
  const after = url.pathname.slice('/api/msha/'.length);
  const slash = after.indexOf('/');
  const mineId = slash === -1 ? after : after.slice(0, slash);
  const sub = slash === -1 ? '' : after.slice(slash + 1);

  if (!mineId) {
    return jsonResp({ error: 'Missing mine ID' }, 400);
  }

  try {
    switch (sub) {
      case 'violations':
        return await fetchViolations(mineId);
      case 'inspections':
        return await fetchInspections(mineId);
      case 'production':
        return await fetchProduction(mineId);
      default:
        return await fetchMineInfo(mineId);
    }
  } catch (e) {
    return jsonResp({ error: e.message }, 502);
  }
}

// ---------------------------------------------------------------------------
// Mine info — POST to BasicMineInfoResults.asp and parse the HTML table
// ---------------------------------------------------------------------------
async function fetchMineInfo(mineId) {
  const resp = await fetch(
    'https://arlweb.msha.gov/drs/ASP/BasicMineInfoResults.asp',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; quarryme-proxy/1.0)',
      },
      body: `MineId=${encodeURIComponent(mineId)}&btnSubmit=Submit`,
    }
  );

  if (!resp.ok) {
    return jsonResp({ error: `MSHA returned ${resp.status}` }, resp.status);
  }

  const html = await resp.text();
  const data = parseMineInfoHtml(html, mineId);
  return jsonResp(data);
}

function parseMineInfoHtml(html, mineId) {
  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

  const result = { MINE_ID: mineId };
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells = [];
    const localCellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = localCellRe.exec(rowHtml)) !== null) {
      cells.push(strip(cellMatch[1]));
    }
    if (cells.length >= 2 && cells[0]) {
      const label = cells[0].replace(/:$/, '').trim().toUpperCase().replace(/\s+/g, '_');
      const value = cells[1];
      if (label && value) result[label] = value;
    }
  }

  const nameMatch = html.match(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/i);
  if (nameMatch && !result.MINE_NAME) {
    result.MINE_NAME = strip(nameMatch[1]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Violations — ViolationsQueryResults.asp
// ---------------------------------------------------------------------------
async function fetchViolations(mineId) {
  const params = new URLSearchParams({
    MineId: mineId,
    EndDate: '',
    StartDate: '',
    SigAndSub: '',
    OrderBy: 'ViolationOccurDate',
    btnSubmit: 'Submit',
  });

  const resp = await fetch(
    'https://arlweb.msha.gov/drs/ASP/ViolationsQueryResults.asp',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; quarryme-proxy/1.0)',
      },
      body: params.toString(),
    }
  );

  if (!resp.ok) {
    return jsonResp({ error: `MSHA returned ${resp.status}` }, resp.status);
  }

  const html = await resp.text();
  const rows = parseTableRows(html);
  return jsonResp({ value: rows });
}

// ---------------------------------------------------------------------------
// Inspections — InspectionQueryResults.asp
// ---------------------------------------------------------------------------
async function fetchInspections(mineId) {
  const params = new URLSearchParams({
    MineId: mineId,
    EndDate: '',
    StartDate: '',
    OrderBy: 'InspEndDate',
    btnSubmit: 'Submit',
  });

  const resp = await fetch(
    'https://arlweb.msha.gov/drs/ASP/InspectionQueryResults.asp',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; quarryme-proxy/1.0)',
      },
      body: params.toString(),
    }
  );

  if (!resp.ok) {
    return jsonResp({ error: `MSHA returned ${resp.status}` }, resp.status);
  }

  const html = await resp.text();
  const rows = parseTableRows(html);
  return jsonResp({ value: rows.slice(0, 5) });
}

async function fetchProduction(mineId) {
  return jsonResp({ value: [], note: 'Production data not available via this proxy' });
}

function parseTableRows(html) {
  const strip = (s) =>
    s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

  const rows = [];
  const headers = [];

  const theadMatch = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  if (theadMatch) {
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let m;
    while ((m = thRe.exec(theadMatch[1])) !== null) {
      headers.push(strip(m[1]).toUpperCase().replace(/\s+/g, '_'));
    }
  }

  const allRows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRe.exec(html)) !== null) {
    allRows.push(trMatch[1]);
  }

  let dataStart = 0;
  if (headers.length === 0 && allRows.length > 0) {
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let m;
    while ((m = thRe.exec(allRows[0])) !== null) {
      headers.push(strip(m[1]).toUpperCase().replace(/\s+/g, '_'));
    }
    if (headers.length > 0) dataStart = 1;
  }

  for (let i = dataStart; i < allRows.length; i++) {
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = tdRe.exec(allRows[i])) !== null) {
      cells.push(strip(m[1]));
    }
    if (cells.length === 0) continue;
    if (headers.length > 0) {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = cells[idx] ?? '';
      });
      rows.push(obj);
    } else {
      rows.push(cells);
    }
  }

  return rows;
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
