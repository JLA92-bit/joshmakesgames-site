"""Scrape 2026 Victorian state election results from the VEC website.

Writes:
  data/districts/<slug>.json   parsed lower house results (primaries, 2CP, booths)
  data/regions/<slug>.json     parsed upper house first preferences
  data/meta.json               discovery info, timings, errors
  data/raw/*.html              raw snapshots of index pages and watch seats (for debugging the parser)

Usage: python -m scraper.vec [--base URL] [--only slug,slug] [--no-booths] [--fixtures DIR]
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from .config import (CANDIDATE_BASES, DISCOVERY_SEEDS, DISTRICT_SLUGS, REGION_SLUGS,
                     VEC, WATCH_SEATS)

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR") or ROOT / "data")
UA = "VicElectionTracker/1.0 (unofficial results tracker; +https://github.com/JLA92-bit/Politics)"

# ---------------------------------------------------------------- fetching

class Fetcher:
    def __init__(self, fixtures: Path | None = None):
        self.fixtures = fixtures
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"})
        self.count = 0

    blocked = 0          # responses that look like rate limiting (999/429/403)
    BLOCK_LIMIT = 6

    def get(self, url: str) -> tuple[int, str]:
        if self.fixtures:
            p = self.fixtures / (re.sub(r"[^a-z0-9]+", "_", urlparse(url).path.lower()).strip("_") + ".html")
            return (200, p.read_text()) if p.exists() else (404, "")
        if Fetcher.blocked >= Fetcher.BLOCK_LIMIT:
            return 998, ""   # stop hammering a site that is rate limiting us; keep last good data
        last = (0, "")
        for attempt in range(3):
            time.sleep(0.6 + random.random() * 0.6)  # be polite: about one request a second per worker
            try:
                self.count += 1
                r = self.s.get(url, timeout=25)
                if r.status_code == 200:
                    return 200, r.text
                last = (r.status_code, "")
                if r.status_code in (404, 410):
                    return last
                if r.status_code in (999, 429, 403):
                    Fetcher.blocked += 1
                    time.sleep(8 * (attempt + 1))
                    if Fetcher.blocked >= Fetcher.BLOCK_LIMIT:
                        return last
            except requests.RequestException as e:  # network blip: retry
                last = (0, str(e))
            time.sleep(1.5 * (attempt + 1))
        return last


# ---------------------------------------------------------------- parsing helpers

def num(text: str | None) -> float | None:
    if text is None:
        return None
    t = text.strip().replace(",", "").replace("%", "").replace("−", "-")
    if t in ("", "-", "–", "—", "n/a", "N/A"):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def heading_for(table) -> str:
    """Nearest caption/heading above a table, used to classify it."""
    cap = table.find("caption")
    if cap and clean(cap.get_text()):
        return clean(cap.get_text())
    prev = table.find_previous(["h1", "h2", "h3", "h4", "h5", "h6", "caption"])
    return clean(prev.get_text()) if prev else ""


def table_matrix(table) -> tuple[list[str], list[list[str]]]:
    rows = table.find_all("tr")
    if not rows:
        return [], []
    header_idx = 0
    for i, tr in enumerate(rows):
        if tr.find("th"):
            header_idx = i
            break
    header = [clean(c.get_text(" ")) for c in rows[header_idx].find_all(["th", "td"])]
    body = []
    for tr in rows[header_idx + 1:]:
        cells = [clean(c.get_text(" ")) for c in tr.find_all(["th", "td"])]
        if any(cells):
            body.append(cells)
    return header, body


TOTAL_RE = re.compile(r"^(total|formal|informal|exhausted|votes? polled)", re.I)


def find_col(header: list[str], *keys: str) -> int | None:
    for k in keys:
        for i, h in enumerate(header):
            if k in h.lower():
                return i
    return None


def parse_candidate_table(header, body):
    ci = find_col(header, "candidate", "name") if header else None
    ci = 0 if ci is None else ci
    pi = find_col(header, "party", "group", "affiliation")
    pct_i = find_col(header, "%")
    vi = None
    for i, h in enumerate(header):
        hl = h.lower()
        if i in (ci, pi, pct_i):
            continue
        if "vote" in hl or "pref" in hl or "count" in hl:
            vi = i
            break
    rows, totals = [], {}
    for cells in body:
        if len(cells) <= ci:
            continue
        name = cells[ci]
        votes = num(cells[vi]) if vi is not None and vi < len(cells) else None
        if votes is None:  # fall back to first numeric cell that is not the % column
            for j, c in enumerate(cells):
                if j not in (ci, pi, pct_i) and num(c) is not None:
                    votes = num(c)
                    break
        pct = num(cells[pct_i]) if pct_i is not None and pct_i < len(cells) else None
        if TOTAL_RE.match(name):
            key = name.lower()
            if "informal" in key:
                totals["informal"] = votes
            elif "formal" in key:
                totals["formal"] = votes
            elif "exhaust" in key:
                totals["exhausted"] = votes
            else:
                totals["total"] = votes
            continue
        if votes is None:
            continue
        rows.append({
            "candidate": name,
            "party": cells[pi] if pi is not None and pi < len(cells) else "",
            "votes": int(votes),
            "pct": pct,
        })
    return rows, totals


def classify(heading: str, header: list[str], booth_page: bool = False) -> str | None:
    h = (heading + " | " + " ".join(header)).lower()
    hdr = " ".join(header).lower()
    if "voting centre" in hdr or "voting center" in hdr or "booth" in hdr:
        return "booths"
    if booth_page and len(header) >= 3 and not find_col(header, "%"):
        return "booths"
    if not header or not any(k in hdr for k in ("vote", "pref", "%")):
        return None
    if "two candidate" in h or "two-candidate" in h or "2cp" in h or "tcp" in h:
        return "tcp"
    if "after distribution" in h or "distribution of preferences" in h or "preference distribution" in h:
        return "final"
    return "primary"


def parse_booth_table(header, body):
    """Wide table: voting centre x candidate/party columns."""
    cols = header[1:]
    rows = []
    for cells in body:
        if not cells:
            continue
        vals = {}
        for c, v in zip(cols, cells[1:]):
            n = num(v)
            if n is not None:
                vals[c] = n
        rows.append({"booth": cells[0], "values": vals})
    return {"columns": cols, "rows": rows}


def page_text_facts(soup) -> dict:
    text = clean(soup.get_text(" "))
    facts = {}
    m = re.search(r"Last updated:?\s*([A-Za-z]+,?\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+[\d:]+(?:\s*[ap]m)?)", text, re.I)
    if m:
        facts["last_updated"] = m.group(1)
    m = re.search(r"(?:Elected member|Successful candidate)s?:?\s+([A-Z][A-Z'\-]+,\s+[A-Za-z'\- ]+?)\s+(?=[A-Z][a-z])", text)
    if m and "will display" not in m.group(0):
        facts["elected"] = clean(m.group(1))
    m = re.search(r"Total enrolled voters:?\s*([\d,]{3,})", text, re.I) or \
        re.search(r"Enrol(?:led|ment)[^0-9]{0,30}([\d,]{4,})", text, re.I)
    if m:
        facts["enrolment"] = int(m.group(1).replace(",", ""))
    for key, pat in (("formal", r"Formal votes:\s*([\d,]+)"), ("informal", r"Informal votes:\s*([\d,]+)"),
                     ("total_votes", r"Total votes:\s*([\d,]+)")):
        m = re.search(pat, text, re.I)
        if m:
            facts[key] = int(m.group(1).replace(",", ""))
    m = re.search(r"\(([\d.]+)%\s*of total enrolled voters\)", text, re.I)
    if m:
        facts["counted_pct"] = float(m.group(1))
    m = re.search(r"Quota:?\s*([\d,]{3,})", text, re.I)
    if m:
        facts["quota"] = int(m.group(1).replace(",", ""))
    notes = []
    for kw in ("provisional", "recheck", "preference distribution", "has been replaced"):
        mm = re.search(r"[^.]*" + kw + r"[^.]*\.", text, re.I)
        if mm and len(mm.group(0)) < 300:
            notes.append(clean(mm.group(0)))
    facts["notes"] = list(dict.fromkeys(notes))[:4]
    return facts


def parse_results_page(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    out = {"url": url, "title": clean(soup.title.get_text()) if soup.title else ""}
    out.update(page_text_facts(soup))
    for table in soup.find_all("table"):
        header, body = table_matrix(table)
        kind = classify(heading_for(table), header, "voting-centre" in url.lower())
        if kind is None:
            continue
        if kind == "booths":
            out.setdefault("booths", parse_booth_table(header, body))
            continue
        rows, totals = parse_candidate_table(header, body)
        if rows and kind not in out:
            out[kind] = rows
            if totals:
                out[kind + "_totals"] = totals
    links = {}
    for a in soup.find_all("a", href=True):
        href = urljoin(url, a["href"])
        low = href.lower()
        if "by-voting-centre" in low and urlparse(href).netloc.endswith("vec.vic.gov.au"):
            links["booths_tcp" if ("2cp" in low or "two-candidate" in low) else "booths_primary"] = href
    out["links"] = links
    return out


# ---------------------------------------------------------------- discovery

DISTRICT_LINK = re.compile(r"(.*)/results-by-district/[a-z\-]+-district-results", re.I)


def discover(f: Fetcher, hint: str | None, log: list) -> str | None:
    def probe(base: str) -> bool:
        url = urljoin(VEC, base.rstrip("/") + "/results-by-district/pakenham-district-results")
        code, html = f.get(url)
        ok = code == 200 and "pakenham" in html.lower() and "<table" in html.lower()
        log.append({"probe": url, "status": code, "ok": ok})
        return ok

    if hint and probe(hint):
        return hint
    seen, queue = set(), [urljoin(VEC, s) for s in DISCOVERY_SEEDS]
    while queue and len(seen) < 25:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        code, html = f.get(url)
        log.append({"crawl": url, "status": code})
        if code != 200:
            continue
        save_raw("index_" + re.sub(r"[^a-z0-9]+", "_", urlparse(url).path.lower()).strip("_"), html)
        soup = BeautifulSoup(html, "lxml")
        for a in soup.find_all("a", href=True):
            href = urljoin(url, a["href"]).split("#")[0]
            if not urlparse(href).netloc.endswith("vec.vic.gov.au"):
                continue
            m = DISTRICT_LINK.match(href)
            if m and "2026" in href:
                base = urlparse(m.group(1)).path
                if probe(base):
                    return base
            low = href.lower()
            if "2026" in low and ("result" in low or "state-election" in low) and href not in seen:
                queue.append(href)
    for base in CANDIDATE_BASES:
        if probe(base):
            return base
    return None


REGION_LINK = re.compile(r"region", re.I)


def region_slug_for(href: str) -> str | None:
    h = href.lower().replace("_", "-")
    for slug in sorted(REGION_SLUGS, key=len, reverse=True):  # longest first: north-eastern before eastern
        if slug in h and "result" in h:
            return slug
    return None


def discover_regions(f: Fetcher, base: str, log: list) -> dict:
    """Upper house pages live under a separate index (e.g. .../region-election-page)."""
    parent = base.rstrip("/").rsplit("/", 1)[0]
    found, pages = {}, [urljoin(VEC, parent + "/region-election-page"), urljoin(VEC, parent), urljoin(VEC, base)]
    for i, url in enumerate(pages):
        if i > 8 or len(found) >= 8:
            break
        code, html = f.get(url)
        log.append({"region_crawl": url, "status": code})
        if code != 200:
            continue
        soup = BeautifulSoup(html, "lxml")
        for a in soup.find_all("a", href=True):
            href = urljoin(url, a["href"]).split("#")[0].split("?")[0]
            if "readspeaker" in href or not urlparse(href).netloc.endswith("vec.vic.gov.au"):
                continue
            rs = region_slug_for(href)
            if rs and rs not in found and "voting-centre" not in href.lower():
                found[rs] = href
            elif REGION_LINK.search(href) and "2026" in href and href not in pages:
                pages.append(href)
    return found


# ---------------------------------------------------------------- io

def save_raw(name: str, html: str):
    d = ROOT / ".raw"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{name}.html").write_text(html)


def write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=1, ensure_ascii=False))
    tmp.replace(path)


def title_name(slug: str) -> str:
    return " ".join(w.capitalize() if w not in ("st",) else "St" for w in slug.split("-"))


# ---------------------------------------------------------------- main scrape

def scrape_district(f: Fetcher, base: str, slug: str, booths: bool) -> dict:
    url = urljoin(VEC, f"{base}/results-by-district/{slug}-district-results")
    code, html = f.get(url)
    rec = {"slug": slug, "name": title_name(slug), "url": url, "status": code,
           "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    if code != 200:
        rec["error"] = f"HTTP {code}"
        return rec
    if slug in WATCH_SEATS or slug == "pakenham":
        save_raw(f"district_{slug}", html)
    rec.update(parse_results_page(html, url))
    rec.pop("booths", None)
    prev_p = DATA / "districts" / f"{slug}.json"
    prev = json.loads(prev_p.read_text()) if prev_p.exists() else {}
    unchanged = prev.get("last_updated") and prev.get("last_updated") == rec.get("last_updated")
    if unchanged:  # count hasn't moved: reuse booth tables instead of refetching
        for key in ("booths_primary", "booths_tcp"):
            if prev.get(key):
                rec[key] = prev[key]
    if booths and not (unchanged and prev.get("booths_primary")):
        for key in ("booths_primary", "booths_tcp"):
            link = rec.get("links", {}).get(key)
            if not link:
                continue
            c2, h2 = f.get(link)
            if c2 == 200:
                if slug == "pakenham":
                    save_raw(f"district_{slug}_{key}", h2)
                sub = parse_results_page(h2, link)
                if sub.get("booths"):
                    rec[key] = sub["booths"]
                    if key == "booths_tcp" and sub.get("tcp") and not rec.get("tcp"):
                        rec["tcp"] = sub["tcp"]
    return rec


def scrape_region(f: Fetcher, base: str, slug: str, url: str | None = None) -> dict:
    url = url or urljoin(VEC, f"{base}/results-by-region/{slug}-region-results")
    code, html = f.get(url)
    rec = {"slug": slug, "name": title_name(slug) + " Region", "url": url, "status": code,
           "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    if code != 200:
        rec["error"] = f"HTTP {code}"
        return rec
    save_raw(f"region_{slug}", html)
    rec.update(parse_results_page(html, url))
    return rec


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("VEC_BASE") or None)
    ap.add_argument("--only", default="")
    ap.add_argument("--no-booths", action="store_true")
    ap.add_argument("--fixtures", default=None)
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args(argv)

    f = Fetcher(Path(a.fixtures) if a.fixtures else None)
    meta_path = DATA / "meta.json"
    old = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    t0 = time.time()
    log: list = []
    base = (a.base or old.get("base")) if old.get("status") == "ok" and old.get("base") and not old.get("blocked_responses") \
        else discover(f, a.base or old.get("base"), log)
    meta = {"scraped_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "base": base, "discovery_log": log[-40:], "errors": []}
    if not base:
        meta["status"] = "waiting"
        meta["message"] = ("Could not find the VEC's 2026 results pages yet. Set the VEC_BASE repository "
                           "variable to the results URL prefix if the VEC uses a new layout.")
        write_json(meta_path, meta)
        print(meta["message"], file=sys.stderr)
        return 0

    iteration = int(old.get("iteration", 0)) + 1
    meta["iteration"] = iteration
    region_urls = old.get("region_urls") or {}
    if len(region_urls) < 8:
        region_urls = discover_regions(f, base, log)
    meta["region_urls"] = region_urls
    # Spread the load: seats that matter for One Nation every pass, the rest every third pass.
    prev_site = DATA / "site.json"
    hot, ranked = set(WATCH_SEATS), []
    if prev_site.exists():
        try:
            for st in json.loads(prev_site.read_text()).get("seats", []):
                pj = st.get("projection") or {}
                ranked.append((pj.get("on_win_prob", 0), st["slug"]))
                if st.get("status") != "ok" or pj.get("on_win_prob", 0) >= 0.05:
                    hot.add(st["slug"])
        except (json.JSONDecodeError, KeyError):
            pass
    # booth pages (2 extra requests each) only for One Nation's best prospects
    booth_ok = set(WATCH_SEATS) | {sl for _, sl in sorted(ranked, reverse=True)[:12]}
    cold = [s for s in DISTRICT_SLUGS if s not in hot]
    slugs = [s for s in a.only.split(",") if s] or \
        [s for s in DISTRICT_SLUGS if s in hot] + [s for i, s in enumerate(cold) if i % 3 == iteration % 3]
    regions_now = [] if a.only or iteration % 2 else REGION_SLUGS
    meta["fetched"] = {"hot": len([s for s in slugs if s in hot]), "cold": len([s for s in slugs if s not in hot]),
                       "regions": len(regions_now)}
    with cf.ThreadPoolExecutor(a.workers) as ex:
        dfuts = {ex.submit(scrape_district, f, base, s, not a.no_booths and s in booth_ok): s for s in slugs}
        rfuts = {ex.submit(scrape_region, f, base, s, region_urls.get(s)): s for s in regions_now}
        for fut in cf.as_completed(list(dfuts) + list(rfuts)):
            try:
                rec = fut.result()
            except Exception as e:  # never let one page kill the run
                s = dfuts.get(fut) or rfuts.get(fut)
                meta["errors"].append({"slug": s, "error": repr(e)})
                continue
            folder = "districts" if fut in dfuts else "regions"
            if rec.get("error"):
                meta["errors"].append({"slug": rec["slug"], "error": rec["error"], "url": rec["url"]})
                prev = DATA / folder / f"{rec['slug']}.json"
                if prev.exists():  # keep last good data rather than blanking a seat
                    continue
            write_json(DATA / folder / f"{rec['slug']}.json", rec)
    meta["discovery_log"] = log[-60:]
    meta["blocked_responses"] = Fetcher.blocked
    meta["status"] = "ok"
    meta["requests"] = f.count
    meta["seconds"] = round(time.time() - t0, 1)
    write_json(meta_path, meta)
    print(f"Scraped {len(slugs)} districts from {base} in {meta['seconds']}s, {len(meta['errors'])} errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
