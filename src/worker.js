/**
 * Cloudflare Worker for quarryme.com
 * Proxies MSHA public web pages to avoid browser CORS restrictions.
 * No API key required — all data sourced from public MSHA pages.
 *
 * Routes:
 *   GET /api/msha/:mineId             -> Mine info (arlweb.msha.gov HTML scrape)
 *   GET /api/msha/:mineId/violations  -> Violations (arlweb.msha.gov HTML scrape)
 *   GET /api/msha/:mineId/inspections -> Inspections (arlweb.msha.gov HTML scrape)
 *   GET /api/msha/:mineId/production  -> Annual production (arlweb.msha.gov HTML scrape)
 *   everything else -> static assets
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname.startsWith('/api/msha/')) {
      return proxyMsha(url, env, request);
    }

    return env.ASSETS.fetch(request);
  },
};

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
  // Strip tags helper
  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

  const result = { MINE_ID: mineId };

  // The BasicMineInfoResults page uses a table with two-column rows: label | value
  // Match every <tr>…</tr> that contains at least two <td> cells
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells = [];
    let cellMatch;
    const localCellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    while ((cellMatch = localCellRe.exec(rowHtml)) !== null) {
      cells.push(strip(cellMatch[1]));
    }
    if (cells.length >= 2 && cells[0]) {
      // Normalise the label: upper-snake-case, strip trailing colon
      const label = cells[0].replace(/:$/, '').trim().toUpperCase().replace(/\s+/g, '_');
      const value = cells[1];
      if (label && value) result[label] = value;
    }
  }

  // Also try to pull the mine name from a heading if present
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

// ---------------------------------------------------------------------------
// Production — no direct HTML page; return empty gracefully
// ---------------------------------------------------------------------------
async function fetchProduction(mineId) {
  // MSHA's production data is bulk-download only; return empty so the UI
  // degrades gracefully rather than erroring.
  return jsonResp({ value: [], note: 'Production data not available via this proxy' });
}

// ---------------------------------------------------------------------------
// Generic HTML table → array-of-objects parser
// ---------------------------------------------------------------------------
function parseTableRows(html) {
  const strip = (s) =>
    s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

  const rows = [];
  const headers = [];

  // Extract header row (th cells)
  const theadMatch = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  if (theadMatch) {
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let m;
    while ((m = thRe.exec(theadMatch[1])) !== null) {
      headers.push(strip(m[1]).toUpperCase().replace(/\s+/g, '_'));
    }
  }

  // If no thead, try first tr for headers
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
