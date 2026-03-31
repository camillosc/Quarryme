#!/usr/bin/env python3
"""
Enrich the quarry records in index.html with MSHA open-data fields.

New fields appended at indices 24-29 of each record:
  [24] mine_type    (str|null)   - CURRENT_MINE_TYPE from Mines.txt
  [25] mine_status  (str|null)   - CURRENT_MINE_STATUS from Mines.txt
  [26] last_insp    (str|null)   - last INSPECTION_END_DT from Inspections.txt
  [27] viol_cnt     (int|null)   - total violation count from Violations.txt
  [28] last_viol    (str|null)   - most recent VIOLATION_OCCUR_DT
  [29] ann_hours    (int|null)   - most recent full-year HOURS_WORKED sum from MinesProdQuarterly.txt
"""

import csv
import io
import json
import os
import re
import sys
import zipfile

WORKTREE = os.path.dirname(os.path.abspath(__file__))
INDEX_HTML = os.path.join(WORKTREE, "index.html")
CACHE_DIR = os.path.join(WORKTREE, "_msha_cache")

ZIPS = {
    "mines":       os.path.join(CACHE_DIR, "mines.zip"),
    "violations":  os.path.join(CACHE_DIR, "violations.zip"),
    "inspections": os.path.join(CACHE_DIR, "inspections.zip"),
    "production":  os.path.join(CACHE_DIR, "production.zip"),
}

for key, path in ZIPS.items():
    if not os.path.exists(path):
        sys.exit(f"ERROR: missing {path} — download it first")


def iter_csv(zip_path, txt_name, encoding="latin-1"):
    with zipfile.ZipFile(zip_path) as zf:
        with zf.open(txt_name) as raw:
            text = io.TextIOWrapper(raw, encoding=encoding, errors="replace")
            # Strip NUL bytes which appear in some MSHA files
            cleaned = (line.replace("\x00", "") for line in text)
            yield from csv.DictReader(cleaned, delimiter="|")


def date_str(val):
    if not val:
        return None
    s = str(val).strip()
    if not s or s.lower() in ("null", "none"):
        return None
    if "T" in s:
        s = s.split("T")[0]
    if "/" in s:
        parts = s.split("/")
        if len(parts) == 3:
            m, d, y = parts
            s = f"{y}-{m.zfill(2)}-{d.zfill(2)}"
    return s if len(s) == 10 and s[4] == "-" else None


# ── 1. Mine metadata ──────────────────────────────────────────────────────────
print("=== Mines.txt ===", flush=True)
mine_type   = {}
mine_status = {}
for row in iter_csv(ZIPS["mines"], "Mines.txt"):
    mid = (row.get("MINE_ID") or "").strip()
    if not mid:
        continue
    t = (row.get("CURRENT_MINE_TYPE") or "").strip()
    s = (row.get("CURRENT_MINE_STATUS") or "").strip()
    if t:
        mine_type[mid]   = t
    if s:
        mine_status[mid] = s
print(f"  {len(mine_type):,} mine-type records, {len(mine_status):,} status records")


# ── 2. Violations ─────────────────────────────────────────────────────────────
print("=== Violations.txt ===", flush=True)
viol_count = {}
viol_last  = {}
for row in iter_csv(ZIPS["violations"], "Violations.txt"):
    mid = (row.get("MINE_ID") or "").strip()
    if not mid:
        continue
    viol_count[mid] = viol_count.get(mid, 0) + 1
    dt = date_str(row.get("VIOLATION_OCCUR_DT") or row.get("VIOLATION_ISSUE_DT") or "")
    if dt and (mid not in viol_last or dt > viol_last[mid]):
        viol_last[mid] = dt
print(f"  {len(viol_count):,} mines with violations")


# ── 3. Inspections ────────────────────────────────────────────────────────────
print("=== Inspections.txt ===", flush=True)
insp_last = {}
for row in iter_csv(ZIPS["inspections"], "Inspections.txt"):
    mid = (row.get("MINE_ID") or "").strip()
    if not mid:
        continue
    dt = date_str(row.get("INSPECTION_END_DT") or "")
    if dt and (mid not in insp_last or dt > insp_last[mid]):
        insp_last[mid] = dt
print(f"  {len(insp_last):,} mines with inspection records")


# ── 4. Production (quarterly → most recent annual sum) ───────────────────────
print("=== MinesProdQuarterly.txt ===", flush=True)
# Accumulate hours per mine per year
hours_by_yr = {}  # mine_id -> {year -> total_hours}
for row in iter_csv(ZIPS["production"], "MinesProdQuarterly.txt"):
    mid = (row.get("MINE_ID") or "").strip()
    if not mid:
        continue
    # Only care about metal/nonmetal (our quarries); skip coal
    if (row.get("COAL_METAL_IND") or "").strip() == "C":
        continue
    yr_raw = (row.get("CAL_YR") or "").strip()
    try:
        yr = int(yr_raw)
    except ValueError:
        continue
    hrs_raw = (row.get("HOURS_WORKED") or "").strip().replace(",", "")
    try:
        hrs = int(float(hrs_raw)) if hrs_raw else 0
    except ValueError:
        hrs = 0
    if hrs <= 0:
        continue
    if mid not in hours_by_yr:
        hours_by_yr[mid] = {}
    hours_by_yr[mid][yr] = hours_by_yr[mid].get(yr, 0) + hrs

# Find the most recent full year for each mine (sum of 4 quarters = fullest data)
ann_hours = {}   # mine_id -> hours
ann_year  = {}   # mine_id -> year
for mid, yr_dict in hours_by_yr.items():
    # Pick the most recent year that has data
    best_yr = max(yr_dict.keys())
    ann_hours[mid] = yr_dict[best_yr]
    ann_year[mid]  = best_yr

print(f"  {len(ann_hours):,} mines with annual-hours data")


# ── 5. Load and enrich quarry records ─────────────────────────────────────────
print("=== Enriching index.html ===", flush=True)
print("  reading ...", flush=True)
with open(INDEX_HTML, "r", encoding="utf-8") as f:
    html = f.read()

pattern = re.compile(
    r'(<script[^>]*\bid=["\']qdata["\'][^>]*>)(.*?)(</script>)',
    re.DOTALL
)
match = pattern.search(html)
if not match:
    sys.exit("ERROR: <script id='qdata'> not found in index.html")

data = json.loads(match.group(2))
print(f"  {len(data):,} quarry records")

found = {"meta": 0, "insp": 0, "viol": 0, "hrs": 0}

for rec in data:
    mid = str(rec[11]).strip() if rec[11] else ""

    # Pad to 30 fields
    while len(rec) < 30:
        rec.append(None)

    rec[24] = mine_type.get(mid)
    rec[25] = mine_status.get(mid)

    li = insp_last.get(mid)
    rec[26] = li
    if li:
        found["insp"] += 1

    vc = viol_count.get(mid)
    rec[27] = vc
    rec[28] = viol_last.get(mid)
    if vc is not None:
        found["viol"] += 1

    ah = ann_hours.get(mid)
    rec[29] = ah
    if ah:
        found["hrs"] += 1

    if mine_type.get(mid) or mine_status.get(mid):
        found["meta"] += 1

print(f"  mine meta:   {found['meta']:,}/{len(data):,}")
print(f"  inspections: {found['insp']:,}/{len(data):,}")
print(f"  violations:  {found['viol']:,}/{len(data):,}")
print(f"  hours/prod:  {found['hrs']:,}/{len(data):,}")


# ── 6. Write updated HTML ─────────────────────────────────────────────────────
print("  serializing ...", flush=True)
new_json = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
new_html = (
    html[: match.start()]
    + match.group(1)
    + new_json
    + match.group(3)
    + html[match.end() :]
)

print("  writing index.html ...", flush=True)
with open(INDEX_HTML, "w", encoding="utf-8") as f:
    f.write(new_html)

sz = os.path.getsize(INDEX_HTML)
print(f"  done — {sz/1e6:.1f} MB")
print("=== Complete ===")
