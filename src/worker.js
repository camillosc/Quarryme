/**
 * Cloudflare Worker for quarryme.com
 * Proxies MSHA data requests to avoid browser CORS restrictions.
 *
 * Routes:
 *   GET /api/msha/:mineId             -> Mine info (data.dol.gov, then MSHA DRS scrape)
 *   GET /api/msha/:mineId/violations  -> Violations (data.dol.gov)
 *   GET /api/msha/:mineId/inspections -> Inspections (data.dol.gov)
 *   GET /api/msha/:mineId/production  -> Production (data.dol.gov)
 *   everything else                   -> static assets
 *
 * No API key required — data.dol.gov is public; MSHA DRS is a scrape fallback.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname.startsWith('/api/msha/')) {
      return proxyMsha(url);
    }

    return env.ASSETS.fetch(request);
  },
};

// ── Router ───────────────────────────────────────────────────────────────────

async function proxyMsha(url) {
  const after = url.pathname.slice('/api/msha/'.length);
  const slash = after.indexOf('/');
  const mineId = slash === -1 ? after : after.slice(0, slash);
  const sub    = slash === -1 ? ''    : after.slice(slash + 1);

  if (!mineId) return jsonResp({ error: 'Missing mine ID' }, 400);

  try {
    switch (sub) {
      case 'violations':
        return jsonResp({ value: await fetchViolations(mineId) });
      case 'inspections':
        return jsonResp({ value: await fetchInspections(mineId) });
      case 'production':
        return jsonResp({ value: await fetchProduction(mineId) });
      default:
        return jsonResp({ value: await fetchMineInfo(mineId) });
    }
  } catch (e) {
    return jsonResp({ error: e.message }, 502);
  }
}

// ── data.dol.gov helper ───────────────────────────────────────────────────────
// Endpoint format: /get/{dataset}/filter/{col}/eq/{val}/format/json

async function dolGet(dataset, mineId) {
  const url = `https://data.dol.gov/get/${dataset}/filter/MINE_ID/eq/${encodeURIComponent(mineId)}/format/json`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'quarryme.com/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`data.dol.gov/${dataset} ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : (data.value || data.results || []);
}

// ── Mine info (with HTML fallback) ───────────────────────────────────────────

async function fetchMineInfo(mineId) {
  // Strategy 1: data.dol.gov
  try {
    const rows = await dolGet('mining_mines', mineId);
    if (rows.length > 0) return rows.map(normalizeMineRow);
  } catch (_) {}

  // Strategy 2: MSHA DRS HTML scrape (arlweb.msha.gov)
  try {
    const html = await fetchDrsPage(mineId);
    const mine = parseDrsHtml(html);
    if (mine) return [mine];
  } catch (_) {}

  // Strategy 3: msha.gov mine-detail page scrape
  try {
    const html = await fetchMineDetailPage(mineId);
    const mine = parseMineDetailHtml(html);
    if (mine) return [mine];
  } catch (_) {}

  return [];
}

// ── Violations ───────────────────────────────────────────────────────────────

async function fetchViolations(mineId) {
  try {
    const rows = await dolGet('mining_violations', mineId);
    return rows
      .map(r => ({
        VIOLATION_OCCUR_DT: r.VIOLATION_OCCUR_DT || r.violation_occur_dt || r['Violation Date'] || null,
        VIOLATION_NO: r.VIOLATION_NO || r.violation_no || null,
        MINE_ID: mineId,
      }))
      .sort((a, b) => ((b.VIOLATION_OCCUR_DT || '') > (a.VIOLATION_OCCUR_DT || '') ? 1 : -1))
      .slice(0, 100);
  } catch (_) {}
  return [];
}

// ── Inspections ──────────────────────────────────────────────────────────────

async function fetchInspections(mineId) {
  try {
    const rows = await dolGet('mining_inspections', mineId);
    return rows
      .map(r => ({
        INSPECTION_END_DT: r.INSPECTION_END_DT || r.inspection_end_dt || r['Inspection End Date'] || null,
        MINE_ID: mineId,
      }))
      .sort((a, b) => ((b.INSPECTION_END_DT || '') > (a.INSPECTION_END_DT || '') ? 1 : -1))
      .slice(0, 1);
  } catch (_) {}
  return [];
}

// ── Production ───────────────────────────────────────────────────────────────

async function fetchProduction(mineId) {
  try {
    const rows = await dolGet('mining_annual_production', mineId);
    return rows
      .map(r => ({
        CAL_YR:       r.CAL_YR || r.cal_yr || r['Calendar Year'] || null,
        PRODUCTION_QTY: r.PRODUCTION_QTY || r.production_qty
                      || r.TOTAL_EXTR_PRODUCE_QTY || r.COAL_PRODUCTION_SHORT_TONS
                      || r.PRODUCTION_SHORT_TONS   || null,
        MINE_ID: mineId,
      }))
      .sort((a, b) => (Number(b.CAL_YR) || 0) - (Number(a.CAL_YR) || 0))
      .slice(0, 5);
  } catch (_) {}
  return [];
}

// ── MSHA DRS HTML scraper (arlweb.msha.gov) ──────────────────────────────────

async function fetchDrsPage(mineId) {
  // The DRS typically accepts the mine ID via GET param; fall back to POST if needed.
  const url = `https://arlweb.msha.gov/drs/ASP/BasicMineInfoResults.asp?MineId=${encodeURIComponent(mineId)}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; quarryme.com/1.0)',
      Accept: 'text/html',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`MSHA DRS ${resp.status}`);
  return resp.text();
}

function parseDrsHtml(html) {
  // Extract adjacent <td>Label</td><td>Value</td> pairs into a flat object.
  const raw = {};
  const re = /<td[^>]*>\s*([^<]{2,80}?)\s*<\/td>\s*<td[^>]*>\s*([^<]{0,200}?)\s*<\/td>/gi;
  for (const [, label, value] of html.matchAll(re)) {
    const k = label.trim().toLowerCase().replace(/[:\s]+/g, '_').replace(/_+$/, '');
    const v = value.trim();
    if (v && !raw[k]) raw[k] = v;
  }
  if (!Object.keys(raw).length) return null;

  return {
    CURRENT_MINE_TYPE:   pick(raw, ['mine_type',         'type_of_mine']),
    CURRENT_MINE_STATUS: pick(raw, ['mine_status',        'status']),
    CURRENT_STATUS_DT:   pick(raw, ['status_date',        'date_of_status', 'status_since']),
    AVG_MINE_EMPL_CNT:   pick(raw, ['average_employees',  'avg_employees',  'average_number_of_employees']),
    DISTRICT:            pick(raw, ['district',           'msha_district']),
    CONTROLLER:          pick(raw, ['controller',         'controlling_entity']),
    OPERATOR:            pick(raw, ['operator',           'operator_name']),
    COMMODITY:           pick(raw, ['primary_sic_code',   'sic_code', 'commodity']),
  };
}

// ── msha.gov mine-detail HTML scraper ────────────────────────────────────────

async function fetchMineDetailPage(mineId) {
  const url = `https://www.msha.gov/mine/mine-detail/${encodeURIComponent(mineId)}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; quarryme.com/1.0)',
      Accept: 'text/html',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`msha.gov detail ${resp.status}`);
  return resp.text();
}

// Parse the Drupal-style CMS field blocks used on www.msha.gov
function parseMineDetailHtml(html) {
  // Typical structure:
  //   <div class="field-label">Mine Type&nbsp;</div>
  //   <div class="field-items"><div class="field-item even">Surface</div></div>
  // Also handles simple <dt>/<dd> lists and plain table rows.

  function extractFieldBlock(label) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // CMS field-label / field-item pattern
    let m = html.match(
      new RegExp(esc + '[^<]*<\\/[^>]+>[\\s\\S]{0,300}?field-item[^"]*"[^>]*>\\s*([^<]{1,200})\\s*<', 'i')
    );
    if (m) return m[1].trim();
    // <dt>/<dd> pattern
    m = html.match(new RegExp('<dt[^>]*>[^<]*' + esc + '[^<]*<\\/dt>\\s*<dd[^>]*>\\s*([^<]{1,200})\\s*<', 'i'));
    if (m) return m[1].trim();
    // Table label / next cell
    m = html.match(new RegExp('<t[dh][^>]*>[^<]*' + esc + '[^<]*<\\/t[dh]>\\s*<td[^>]*>\\s*([^<]{1,200})\\s*<', 'i'));
    if (m) return m[1].trim();
    return null;
  }

  const type   = extractFieldBlock('Mine Type');
  const status = extractFieldBlock('Mine Status');
  const statusDt = extractFieldBlock('Status Date') || extractFieldBlock('Status Since');
  const empls  = extractFieldBlock('Average Employees') || extractFieldBlock('Avg.*Employees');
  const dist   = extractFieldBlock('District');

  if (!type && !status && !empls) return null;

  return {
    CURRENT_MINE_TYPE:   type,
    CURRENT_MINE_STATUS: status,
    CURRENT_STATUS_DT:   statusDt,
    AVG_MINE_EMPL_CNT:   empls,
    DISTRICT:            dist,
  };
}

// ── Field normalizer for data.dol.gov mine rows ───────────────────────────────

function normalizeMineRow(r) {
  return {
    CURRENT_MINE_TYPE:   r.CURRENT_MINE_TYPE   || r.current_mine_type   || r['Mine Type']    || null,
    CURRENT_MINE_STATUS: r.CURRENT_MINE_STATUS  || r.current_mine_status || r['Mine Status']  || null,
    CURRENT_STATUS_DT:   r.CURRENT_STATUS_DT    || r.current_status_dt   || r['Status Date']  || null,
    AVG_MINE_EMPL_CNT:   r.AVG_MINE_EMPL_CNT    || r.avg_mine_empl_cnt   || r['Avg Employees']|| null,
    DISTRICT:            r.DISTRICT             || r.district            || null,
    MINE_NAME:           r.MINE_NAME            || r.mine_name           || r['Mine Name']    || null,
    CONTROLLER:          r.CONTROLLER           || r.controller          || null,
    OPERATOR:            r.OPERATOR             || r.operator            || null,
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
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
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
