"""Pre-count baseline: 2022 seat results (fetched once from the VEC) plus final 2026 polls.

The 2026 election uses the same district boundaries as 2022, so 2022 results are a like-for-like baseline.
Writes data/baseline.json. Safe to re-run: skips the fetch when the file already has all 88 seats.
"""
from __future__ import annotations

import json
import sys
from urllib.parse import urljoin

from .analyse import party_code
from .config import DISTRICT_SLUGS, VEC
from .vec import DATA, Fetcher, parse_results_page, title_name

BASE_2022 = "/results/state-election-results/2022-state-election-results/results-by-district"

# Seats that changed hands at by-elections after 2022 (party holding the seat going into 2026).
HOLDER_OVERRIDES = {
    "prahran": {"code": "LIB", "name": "WESTAWAY, Rachel", "note": "Won from the Greens at the February 2025 by-election"},
    "werribee": {"code": "ALP", "name": "LISTER, John", "note": "Held for Labor by 0.8% at the February 2025 by-election"},
    "nepean": {"code": "LIB", "name": "MARSH, Anthony", "note": "Held for the Liberals at the May 2026 by-election"},
    "warrandyte": {"code": "LIB", "name": "WERNER, Nicole", "note": "Held for the Liberals at the August 2023 by-election"},
    "mulgrave": {"code": "ALP", "name": "FOSTER, Eden", "note": "Held for Labor at the November 2023 by-election"},
    "narracan": {"code": "LIB", "name": "FARNHAM, Wayne", "note": "Won the January 2023 supplementary election"},
}

# Narracan's 2022 lower house poll failed (a candidate died) and was re-run in January 2023 without Labor.
NARRACAN_2023 = {"name": "Narracan", "primary": {"LIB": 45.0, "GRN": 11.1, "IND": 14.9, "OTH": 29.0},
                 "winner": {"candidate": "FARNHAM, Wayne", "code": "LIB"},
                 "final": [{"candidate": "FARNHAM, Wayne", "code": "LIB", "pct": 63.0},
                           {"candidate": "WOLFE, Tony", "code": "IND", "pct": 37.0}], "margin": 13.0}

# Final pre-election polls, statewide first preferences (%). The Coalition figure is split into Liberal and
# Nationals using their 2022 ratio. Sources: Newspoll, DemosAU/PremierNational, Freshwater Strategy and
# Resolve Strategic, as reported 25-27 November 2026.
POLLS = [
    {"name": "Newspoll", "COAL": 33, "ALP": 20, "ON": 18, "GRN": 17},
    {"name": "DemosAU", "COAL": 34, "ALP": 19, "ON": 16, "GRN": 16},
    {"name": "Freshwater Strategy", "COAL": 34, "ALP": 21, "ON": 23, "GRN": 15},
    {"name": "Resolve Strategic", "COAL": 31, "ALP": 20, "ON": 25, "GRN": None},
]


def poll_average() -> dict:
    avg = {}
    for k in ("COAL", "ALP", "ON", "GRN"):
        xs = [p[k] for p in POLLS if p.get(k) is not None]
        avg[k] = round(sum(xs) / len(xs), 1)
    avg["OTHERS"] = round(100 - sum(avg.values()), 1)
    return avg


def fetch_2022(f: Fetcher) -> dict:
    out = {}
    for slug in DISTRICT_SLUGS:
        url = urljoin(VEC, f"{BASE_2022}/{slug}-district-results")
        code, html = f.get(url)
        if code != 200:
            continue
        rec = parse_results_page(html, url)
        prim = rec.get("primary") or []
        if not prim:
            continue
        tot = sum(r["votes"] for r in prim)
        by = {}
        for r in prim:
            c = party_code(r.get("party", ""))
            by[c] = by.get(c, 0) + r["votes"]
        final = rec.get("final") or rec.get("tcp") or []
        ftot = sum(r["votes"] for r in final) or 1
        final = sorted(final, key=lambda r: -r["votes"])
        win = final[0] if final else max(prim, key=lambda r: r["votes"])
        out[slug] = {
            "name": title_name(slug),
            "primary": {k: round(100 * v / tot, 2) for k, v in by.items()},
            "winner": {"candidate": win["candidate"], "code": party_code(win.get("party", ""))},
            "final": [{"candidate": r["candidate"], "code": party_code(r.get("party", "")),
                       "pct": round(100 * r["votes"] / ftot, 2)} for r in final[:2]],
        }
        if len(out[slug]["final"]) == 2:
            out[slug]["margin"] = round(out[slug]["final"][0]["pct"] - 50, 2)
    return out


def main():
    path = DATA / "baseline.json"
    old = json.loads(path.read_text()) if path.exists() else {}
    seats = old.get("seats", {})
    if len([k for k in seats if k != "narracan"]) < 87:
        fresh = fetch_2022(Fetcher())
        seats.update(fresh)
    seats.setdefault("narracan", NARRACAN_2023)
    for s in seats.values():
        s["holder"] = {"code": s["winner"]["code"], "name": s["winner"]["candidate"], "note": "Won at the 2022 election"}
    for slug, o in HOLDER_OVERRIDES.items():
        if slug in seats:
            seats[slug]["holder"] = o
    out = {"seats": seats, "polls": POLLS, "poll_average": poll_average()}
    path.write_text(json.dumps(out, indent=1))
    print(f"Baseline: {len(seats)} seats from 2022, poll average {out['poll_average']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
