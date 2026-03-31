"""
inject_msha_production.py

Reads MSHA MinesProdQuarterly data, computes annual production from
hours worked (23 tons/hr for non-coal mines), then updates index.html
quarry data array in-place:
  - d[12] = production tons/yr  (updated from MSHA hours)
  - d[14] = 2  (MSHA-derived, was 0=estimate, 1=SEC)

Only updates mines where d[14]==0 (current estimates).
SEC-calibrated mines (d[14]==1) are left unchanged.
"""

import csv, zipfile, io, json, re
from collections import defaultdict

CACHE = 'C:/Users/owner/Documents/Quarryme/.claude/worktrees/determined-poitras/_msha_cache'
INDEX = 'C:/Users/owner/Documents/Quarryme/.claude/worktrees/silly-babbage/index.html'
YEAR = 2024
TONS_PER_HOUR = 23  # industry standard for aggregate quarries

# ── 1. Build hours_by_mine from MinesProdQuarterly ────────────────────────────
print(f"Reading MinesProdQuarterly for {YEAR}...")
hours_by_mine = defaultdict(float)

with zipfile.ZipFile(f'{CACHE}/production.zip') as z:
    with z.open('MinesProdQuarterly.txt') as f:
        text = io.TextIOWrapper(f, encoding='latin-1')
        reader = csv.DictReader(text, delimiter='|')
        for row in reader:
            if row['COAL_METAL_IND'] != 'M':   # skip coal mines
                continue
            try:
                yr = int(row['CAL_YR'])
            except ValueError:
                continue
            if yr != YEAR:
                continue
            try:
                hrs = float(row['HOURS_WORKED'] or 0)
            except ValueError:
                hrs = 0
            mine_id = row['MINE_ID'].strip().zfill(7)
            hours_by_mine[mine_id] += hrs

print(f"  Loaded hours for {len(hours_by_mine):,} non-coal mines in {YEAR}")

# ── 2. Read index.html ────────────────────────────────────────────────────────
print("Reading index.html...")
with open(INDEX, encoding='utf-8') as fh:
    html = fh.read()

# ── 3. Find and parse the qdata JSON ─────────────────────────────────────────
# The qdata block looks like:
#   <script id="qdata" type="application/json">[[...],[...],...]</script>
pattern = r'(<script id="qdata" type="application/json">)([\s\S]*?)(</script>)'
m = re.search(pattern, html)
if not m:
    raise RuntimeError("Could not find qdata script block")

prefix, raw_json, suffix = m.group(1), m.group(2), m.group(3)
data = json.loads(raw_json)
print(f"  Parsed {len(data):,} quarry entries")

# ── 4. Update each quarry ─────────────────────────────────────────────────────
updated = 0
no_data = 0

for entry in data:
    if len(entry) < 15:
        continue
    is_sec = entry[14]
    if is_sec == 1:      # keep SEC-calibrated data
        continue
    msha_id = str(entry[11]).strip().zfill(7) if entry[11] else None
    if not msha_id:
        continue
    hours = hours_by_mine.get(msha_id)
    if not hours:
        no_data += 1
        continue
    prod = round(hours * TONS_PER_HOUR)
    entry[12] = prod
    entry[14] = 2        # MSHA-derived
    updated += 1

print(f"  Updated: {updated:,}  |  No MSHA data: {no_data:,}  |  SEC kept: {len(data)-updated-no_data:,}")

# ── 5. Serialize and write back ───────────────────────────────────────────────
print("Writing updated index.html...")
new_json = json.dumps(data, separators=(',', ':'), ensure_ascii=False)
new_html = html[:m.start()] + prefix + new_json + suffix + html[m.end():]

with open(INDEX, 'w', encoding='utf-8') as fh:
    fh.write(new_html)

print("Done.")
