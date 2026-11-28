"""Turn scraped VEC results into One Nation focused analysis for the website.

Reads data/districts/*.json, data/regions/*.json, data/meta.json
Writes data/site.json (everything the site needs) and appends data/history.json
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
from pathlib import Path

from .config import COUNCIL_MAJORITY, DISTRICT_SLUGS, MAJORITY, REGION_QUOTA, REGION_SLUGS, WATCH_SEATS

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("DATA_DIR") or ROOT / "data")

PARTY_NAMES = {
    "ON": "One Nation", "ALP": "Labor", "LIB": "Liberal", "NAT": "Nationals", "GRN": "Greens",
    "IND": "Independent", "OTH": "Other",
}
COALITION = {"LIB", "NAT"}


def party_code(party: str, candidate: str = "") -> str:
    p = (party or "").lower()
    if "one nation" in p or "hanson" in p:
        return "ON"
    if "labor" in p and "democratic labour" not in p and "dlp" not in p:
        return "ALP"
    if "libertarian" in p:
        return "OTH"
    if "liberal" in p:
        return "LIB"
    if "national" in p:
        return "NAT"
    if "green" in p:
        return "GRN"
    if p in ("", "independent", "ind") or "independent" in p:
        return "IND"
    return "OTH"


def surname(c: str) -> str:
    return (c or "").split(",")[0].strip().lower()


def load(folder: str) -> dict:
    out = {}
    d = DATA / folder
    if d.exists():
        for p in d.glob("*.json"):
            try:
                out[p.stem] = json.loads(p.read_text())
            except json.JSONDecodeError:
                pass
    return out


def r1(x):
    return None if x is None else round(x, 1)


# ---------------------------------------------------------------- lower house

def match_col(cols: list[str], cand: dict) -> str | None:
    s = surname(cand["candidate"])
    for c in cols:
        if s and s in c.lower():
            return c
    pc = cand["code"]
    for c in cols:
        if party_code(c) == pc and pc not in ("IND", "OTH"):
            return c
    return None


def booth_flow(rec: dict, prim: list, tcp: list) -> dict | None:
    """Estimate share of 'other' (non-2CP) primary votes flowing to each 2CP candidate,
    using only booths that have both a primary and a 2CP count."""
    bp, bt = rec.get("booths_primary"), rec.get("booths_tcp")
    if not bp or not bt or len(tcp) != 2:
        return None
    pcols = {c["candidate"]: match_col(bp["columns"], c) for c in prim}
    tcols = [match_col(bt["columns"], c) for c in tcp]
    pa, pb = pcols.get(tcp[0]["candidate"]), pcols.get(tcp[1]["candidate"])
    if None in tcols or not pa or not pb:
        return None
    prim_by_booth = {r["booth"]: r["values"] for r in bp["rows"]}
    gained_a = others = 0.0
    booths = 0
    for r in bt["rows"]:
        pv = prim_by_booth.get(r["booth"])
        if not pv or TOTALISH.search(r["booth"]):
            continue
        ta, tb = r["values"].get(tcols[0]), r["values"].get(tcols[1])
        if ta is None or tb is None or ta + tb == 0:
            continue
        formal = sum(v for k, v in pv.items() if pcols_values(k, pcols))
        oth = formal - pv.get(pa, 0) - pv.get(pb, 0)
        if oth <= 0:
            continue
        gained_a += ta - pv.get(pa, 0)
        others += oth
        booths += 1
    if booths == 0 or others <= 0:
        return None
    fa = max(0.0, min(1.0, gained_a / others))
    return {"to": [tcp[0]["code"], tcp[1]["code"]], "share_to_first": fa, "booths": booths,
            "other_votes": int(others)}


TOTALISH = re.compile(r"(total|^formal|informal|^enrol|^votes)", re.I)


def pcols_values(col: str, pcols: dict) -> bool:
    return col in pcols.values()


def analyse_seat(slug: str, rec: dict | None) -> dict:
    name = (rec or {}).get("name") or slug.replace("-", " ").title()
    seat = {"slug": slug, "name": name, "watch": WATCH_SEATS.get(slug), "url": (rec or {}).get("url")}
    if not rec or rec.get("error") or not rec.get("primary"):
        seat.update(status="no-data", headline="No results yet", meaning=[
            "The VEC hasn't published counted votes for this seat yet. Check back as booths report in."])
        return seat

    prim = [dict(r, code=party_code(r.get("party", ""), r["candidate"])) for r in rec["primary"]]
    formal = sum(r["votes"] for r in prim)
    informal = rec.get("informal") or (rec.get("primary_totals") or {}).get("informal") or 0
    for r in prim:
        r["pct"] = 100 * r["votes"] / formal if formal else 0
    prim.sort(key=lambda r: -r["votes"])
    enrol = rec.get("enrolment")
    counted = rec.get("counted_pct") or (100 * (formal + informal) / enrol if enrol else None)

    tcp = []
    for r in rec.get("tcp") or []:
        tcp.append(dict(r, code=party_code(r.get("party", ""), r["candidate"])))
    if tcp and not any(r.get("party") for r in tcp):  # 2CP table may only list names
        by_s = {surname(p["candidate"]): p for p in prim}
        for r in tcp:
            p = by_s.get(surname(r["candidate"]))
            if p:
                r["code"], r["party"] = p["code"], p["party"]
    tcp_total = sum(r["votes"] for r in tcp)
    for r in tcp:
        r["pct"] = 100 * r["votes"] / tcp_total if tcp_total else 0
    tcp.sort(key=lambda r: -r["votes"])

    on = next((r for r in prim if r["code"] == "ON"), None)
    on_rank = prim.index(on) + 1 if on else None
    on_tcp = next((r for r in tcp if r["code"] == "ON"), None)

    # who leads
    elected = rec.get("elected")
    if elected:
        win = next((r for r in prim if surname(r["candidate"]) in elected.lower()), None)
        leader, confidence = (win["code"] if win else "OTH"), "called"
        margin = None
    elif len(tcp) == 2 and tcp_total:
        leader = tcp[0]["code"]
        margin = tcp[0]["pct"] - 50
        share = tcp_total / formal if formal else 0
        confidence = "leading" if margin >= 4 and share >= 0.25 else ("close" if margin < 2 else "early")
    else:
        leader, margin, confidence = prim[0]["code"], None, "early"

    # what One Nation needs (full preferential voting: every vote ends up with one of the final two)
    needs = None
    if on and formal:
        rival = next(r for r in prim if r is not on)
        others = formal - on["votes"] - rival["votes"]
        if others > 0:
            need = (formal / 2 - on["votes"]) / others
            needs = {"rival": rival["code"], "rival_name": rival["candidate"],
                     "share_needed": max(0.0, need), "others_pct": 100 * others / formal}

    flow = booth_flow(rec, prim, tcp) if len(tcp) == 2 else None
    flow_on = None
    if flow and on_tcp:
        flow_on = flow["share_to_first"] if tcp[0]["code"] == "ON" else 1 - flow["share_to_first"]
    elif on_tcp and len(tcp) == 2 and formal and tcp_total >= 0.9 * formal:
        rival = next(r for r in tcp if r is not on_tcp)
        rp = next((p for p in prim if surname(p["candidate"]) == surname(rival["candidate"])), None)
        oth = formal - on["votes"] - (rp["votes"] if rp else 0)
        if oth > 0:
            flow_on = max(0.0, min(1.0, (on_tcp["votes"] - on["votes"]) / oth))

    projected = None
    if on and needs and flow_on is not None:
        others = needs["others_pct"] / 100 * formal
        proj = 100 * (on["votes"] + flow_on * others) / formal
        projected = {"on_2cp": proj, "basis": "booth-matched preference flow" if flow else "seat-wide 2CP"}

    third = prim[2] if len(prim) > 2 else None

    seat.update(
        status="ok", enrolment=enrol, formal=formal, informal=informal, counted_pct=r1(counted),
        last_updated=rec.get("last_updated"), elected=elected, notes=rec.get("notes", []),
        primary=[{"candidate": r["candidate"], "party": r["party"], "code": r["code"],
                  "votes": r["votes"], "pct": r1(r["pct"])} for r in prim],
        tcp=[{"candidate": r["candidate"], "party": r.get("party", ""), "code": r["code"],
              "votes": r["votes"], "pct": r1(r["pct"])} for r in tcp],
        tcp_total=tcp_total, tcp_share_counted=r1(100 * tcp_total / formal) if formal and tcp_total else None,
        leader=leader, confidence=confidence, margin=r1(margin),
        on={"pct": r1(on["pct"]) if on else None, "rank": on_rank, "candidate": on["candidate"] if on else None,
            "in_tcp": bool(on_tcp), "tcp_pct": r1(on_tcp["pct"]) if on_tcp else None,
            "needs": {k: (r1(100 * v) if k == "share_needed" else (r1(v) if isinstance(v, float) else v))
                      for k, v in needs.items()} if needs else None,
            "flow": r1(100 * flow_on) if flow_on is not None else None,
            "projected_2cp": r1(projected["on_2cp"]) if projected else None,
            "projection_basis": projected["basis"] if projected else None},
        third={"candidate": third["candidate"], "code": third["code"], "pct": r1(third["pct"])} if third else None,
        booths_primary=rec.get("booths_primary"), booths_tcp=rec.get("booths_tcp"),
    )
    seat["on_status"] = on_status(seat)
    seat["headline"], seat["meaning"] = explain_seat(seat)
    return seat


def on_status(s: dict) -> str:
    on = s["on"]
    if on["pct"] is None:
        return "no-candidate"
    if s.get("elected"):
        return "won" if s["leader"] == "ON" else "lost"
    if on["in_tcp"]:
        if s["leader"] == "ON":
            return "leading" if (s["margin"] or 0) >= 2 else "ahead-close"
        return "trailing-close" if (s["margin"] or 99) < 3 else "trailing"
    if on["rank"] and on["rank"] <= 2 and (on["needs"] or {}).get("share_needed", 100) <= 65:
        return "contender"
    if on["rank"] == 3 and on["pct"] >= 15:
        return "kingmaker"
    return "outside"


def pn(code: str) -> str:
    return PARTY_NAMES.get(code, code)


def explain_seat(s: dict) -> tuple[str, list[str]]:
    on, m = s["on"], []
    cp = s.get("counted_pct")
    early = cp is not None and cp < 20
    if on["pct"] is None:
        return "No One Nation candidate", ["One Nation is not on the ballot here, so this seat only matters to it "
                                           "through the overall seat count."]
    lead = s["primary"][0]
    if on["rank"] == 1:
        m.append(f"One Nation tops the first-preference vote on {on['pct']}%, "
                 f"{r1(on['pct'] - s['primary'][1]['pct'])} points clear of {pn(s['primary'][1]['code'])}.")
    else:
        m.append(f"One Nation is {ordinal(on['rank'])} on first preferences with {on['pct']}%, behind "
                 f"{pn(lead['code'])} on {lead['pct']}%.")
    n = on.get("needs")
    if n and on["rank"] <= 3:
        m.append(f"To win, One Nation needs about {n['share_needed']}% of the {n['others_pct']}% of votes that went to "
                 f"other candidates to flow its way ahead of {pn(n['rival'])}.")
    if on["in_tcp"]:
        if s["leader"] == "ON":
            m.append(f"After preferences One Nation leads {s['tcp'][1]['candidate'].split(',')[0].title()} "
                     f"{on['tcp_pct']}% to {s['tcp'][1]['pct']}%.")
        else:
            m.append(f"After preferences One Nation trails {pn(s['leader'])} {on['tcp_pct']}% to {s['tcp'][0]['pct']}%.")
        if on.get("flow") is not None:
            m.append(f"Preferences from other candidates are flowing about {on['flow']}% to One Nation.")
        if s.get("tcp_share_counted") is not None and s["tcp_share_counted"] < 60:
            m.append(f"Only {s['tcp_share_counted']}% of counted votes have a preference count yet, so this can move.")
    elif s.get("tcp"):
        m.append(f"The VEC's preference count is between {pn(s['tcp'][0]['code'])} and {pn(s['tcp'][1]['code'])}, "
                 "so it expects One Nation to miss the final two. If One Nation beats one of them on primaries, "
                 "the VEC will redo the preference count.")
    if on.get("projected_2cp") is not None and not s.get("elected"):
        verdict = "a win" if on["projected_2cp"] > 50 else "a loss"
        m.append(f"Projecting that flow across every vote counted so far points to {verdict} "
                 f"(about {on['projected_2cp']}% to One Nation after preferences).")
    t = s.get("third")
    if t and t["code"] != "ON" and on["rank"] <= 2:
        who = "An independent" if t["code"] == "IND" else ("A minor-party candidate" if t["code"] == "OTH" else f"The {pn(t['code'])} candidate")
        m.append(f"{who} is third on {t['pct']}%. {third_party_note(t['code'])}")
    if early:
        m.append(f"Only about {cp}% of enrolled voters are counted. Early booths are often small and unrepresentative.")
    head = {
        "won": "One Nation wins", "lost": "One Nation misses out", "leading": "One Nation leading",
        "ahead-close": "One Nation narrowly ahead", "trailing-close": "One Nation narrowly behind",
        "trailing": "One Nation behind after preferences", "contender": "One Nation in contention",
        "kingmaker": "One Nation third: its preferences matter", "outside": "One Nation out of contention",
    }[s["on_status"]]
    return head, m


def third_party_note(code: str) -> str:
    return {
        "LIB": "Liberal preferences usually favour One Nation over Labor or the Greens, which helps it here.",
        "NAT": "Nationals preferences usually favour One Nation over Labor, which helps it here.",
        "ALP": "Labor voters tend to put One Nation last, which hurts it here.",
        "GRN": "Greens voters overwhelmingly put One Nation last, which hurts it here.",
    }.get(code, "Independent and minor-party preferences scatter, so this is harder to predict.")


def ordinal(n: int) -> str:
    return {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth"}.get(n, f"{n}th")


# ---------------------------------------------------------------- statewide + paths to power

def statewide(seats: list) -> dict:
    tot, formal = {}, 0
    for s in seats:
        for r in s.get("primary", []):
            tot[r["code"]] = tot.get(r["code"], 0) + r["votes"]
            formal += r["votes"]
    return {"formal": formal, "votes": tot,
            "pct": {k: r1(100 * v / formal) for k, v in sorted(tot.items(), key=lambda kv: -kv[1])} if formal else {}}


def paths_to_power(seats: list) -> dict:
    tally = {}
    for s in seats:
        if s["status"] != "ok":
            continue
        tally[s["leader"]] = tally.get(s["leader"], 0) + 1
    coal = sum(tally.get(c, 0) for c in COALITION)
    on, alp, grn = tally.get("ON", 0), tally.get("ALP", 0), tally.get("GRN", 0)
    other = sum(v for k, v in tally.items() if k not in COALITION | {"ON", "ALP", "GRN"})
    reported = sum(tally.values())
    pending = 88 - reported
    on_seats = [s for s in seats if s["status"] == "ok" and s["on"]["pct"] is not None]
    close = sorted([s for s in on_seats if s["on_status"] in ("ahead-close", "trailing-close", "contender")],
                   key=lambda s: abs(s.get("margin") or 0))
    scenarios = []

    def sc(key, title, ok, detail):
        scenarios.append({"key": key, "title": title, "met": ok, "detail": detail})

    sc("on-majority", "One Nation governs alone", on >= MAJORITY,
       f"Needs {MAJORITY} seats. Leading in {on}. Short by {max(0, MAJORITY - on)}.")
    sc("on-largest-right", "One Nation leads a right-wing government", on > coal and on + coal >= MAJORITY,
       f"One Nation would need more seats than the Coalition ({coal}) and the two together to reach {MAJORITY}.")
    king = coal < MAJORITY and coal + on >= MAJORITY
    sc("kingmaker", "One Nation is kingmaker for a Coalition government", king,
       f"Coalition leading in {coal}. If it falls short of {MAJORITY} but Coalition + One Nation reaches it, "
       f"One Nation can demand a deal. Coalition + One Nation = {coal + on}.")
    sc("coalition-majority", "Coalition governs alone", coal >= MAJORITY,
       f"Coalition leading in {coal}. If it reaches {MAJORITY} it doesn't need One Nation in the lower house.")
    sc("labor-holds", "Labor holds on", alp >= MAJORITY or (alp + grn + other >= MAJORITY and coal + on < MAJORITY),
       f"Labor leading in {alp}, Greens {grn}, others {other}.")
    if king:
        summary = (f"On current leads One Nation holds the balance of power: the Coalition is {MAJORITY - coal} "
                   f"short of a majority and One Nation's {on} seats would get it there.")
    elif coal >= MAJORITY:
        summary = ("On current leads the Coalition has a majority on its own, so One Nation's influence would "
                   "come through the upper house rather than the lower house.")
    elif on >= MAJORITY:
        summary = "On current leads One Nation has a majority in its own right."
    else:
        need = MAJORITY - coal - on
        summary = (f"On current leads the Coalition ({coal}) and One Nation ({on}) together are {need} short of "
                   f"{MAJORITY}. One Nation's leverage depends on the Coalition gaining seats too.")
    if pending > 20:
        summary += f" {pending} seats have no usable count yet, so treat this as very early."
    return {"tally": tally, "coalition": coal, "on": on, "alp": alp, "grn": grn, "other": other,
            "reported": reported, "pending": pending, "majority": MAJORITY, "scenarios": scenarios,
            "summary": summary,
            "close_races": [{"slug": s["slug"], "name": s["name"], "status": s["on_status"],
                             "margin": s.get("margin"), "on_pct": s["on"]["pct"],
                             "on_tcp": s["on"]["tcp_pct"], "needs": (s["on"]["needs"] or {}).get("share_needed")}
                            for s in close[:15]]}


# ---------------------------------------------------------------- upper house

def analyse_region(slug: str, rec: dict | None) -> dict:
    name = (rec or {}).get("name") or slug.replace("-", " ").title() + " Region"
    out = {"slug": slug, "name": name, "url": (rec or {}).get("url")}
    rows = (rec or {}).get("primary") or []
    if not rows:
        out["status"] = "no-data"
        return out
    by = {}
    for r in rows:
        key = r.get("party") or r["candidate"]
        code = party_code(key, r["candidate"])
        g = by.setdefault(key, {"name": key, "code": code, "votes": 0})
        g["votes"] += r["votes"]
    total = sum(g["votes"] for g in by.values())
    groups = sorted(by.values(), key=lambda g: -g["votes"])
    for g in groups:
        g["pct"] = 100 * g["votes"] / total if total else 0
        g["quotas"] = g["pct"] / (100 * REGION_QUOTA)
    # crude estimate: full quotas first, then largest remainders (ignores preference deals)
    seats = {g["name"]: int(g["quotas"]) for g in groups}
    left = 5 - sum(seats.values())
    for g in sorted(groups, key=lambda g: -(g["quotas"] - int(g["quotas"])))[:max(0, left)]:
        seats[g["name"]] += 1
    on = next((g for g in groups if g["code"] == "ON"), None)
    out.update(status="ok", total=total, last_updated=rec.get("last_updated"),
               groups=[{"name": g["name"], "code": g["code"], "votes": g["votes"], "pct": r1(g["pct"]),
                        "quotas": round(g["quotas"], 2), "est_seats": seats[g["name"]]} for g in groups[:12]],
               on={"pct": r1(on["pct"]) if on else None, "quotas": round(on["quotas"], 2) if on else None,
                   "est_seats": seats[on["name"]] if on else 0})
    if on:
        q = on["quotas"]
        out["meaning"] = (f"One Nation has {round(q, 2)} quotas ({r1(on['pct'])}% against a quota of 16.7%). "
                          + ("That locks in at least one seat. " if q >= 1 else "That's short of a full quota, so it relies on preferences. ")
                          + ("Its leftover vote is large enough to compete for a second seat." if q % 1 > 0.5 and q >= 1 else ""))
    return out


def council(regions: list) -> dict:
    seats = {}
    for r in regions:
        for g in r.get("groups", []):
            if g["est_seats"]:
                seats[g["code"]] = seats.get(g["code"], 0) + g["est_seats"]
    right = sum(seats.get(c, 0) for c in ("LIB", "NAT"))
    on = seats.get("ON", 0)
    left = seats.get("ALP", 0) + seats.get("GRN", 0)
    pivotal = right < COUNCIL_MAJORITY <= right + on
    return {"est_seats": seats, "on": on, "coalition": right, "left": left, "majority": COUNCIL_MAJORITY,
            "on_pivotal": pivotal,
            "summary": (f"Rough estimate from first preferences: One Nation {on}, Coalition {right}, Labor + Greens {left} "
                        f"of 40. " + ("Coalition would need One Nation's votes to pass laws in the upper house. "
                                      if pivotal else "")
                        + "Preferences decide the last seat in each region, so this can still shift.")}


# ---------------------------------------------------------------- main

def main():
    meta = json.loads((DATA / "meta.json").read_text()) if (DATA / "meta.json").exists() else {}
    drecs, rrecs = load("districts"), load("regions")
    seats = [analyse_seat(s, drecs.get(s)) for s in DISTRICT_SLUGS]
    regions = [analyse_region(s, rrecs.get(s)) for s in REGION_SLUGS]
    sw = statewide(seats)
    ptp = paths_to_power(seats)
    on_status_counts = {}
    for s in seats:
        k = s.get("on_status", s["status"])
        on_status_counts[k] = on_status_counts.get(k, 0) + 1
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    site = {"generated_at": now, "scraped_at": meta.get("scraped_at"), "source_status": meta.get("status", "waiting"),
            "source_message": meta.get("message"), "source_base": meta.get("base"),
            "statewide": sw, "paths": ptp, "on_status_counts": on_status_counts,
            "seats": [{k: v for k, v in s.items() if k not in ("booths_primary", "booths_tcp")} for s in seats],
            "regions": regions, "council": council(regions)}
    hist_p = DATA / "history.json"
    hist = json.loads(hist_p.read_text()) if hist_p.exists() else []
    point = {"t": now, "formal": sw["formal"], "on_pct": sw["pct"].get("ON"), "on_leading": ptp["on"],
             "coalition": ptp["coalition"], "alp": ptp["alp"],
             "on_in_tcp": sum(1 for s in seats if s.get("on", {}).get("in_tcp"))}
    if sw["formal"] and (not hist or hist[-1]["formal"] != sw["formal"]):
        hist.append(point)
        hist_p.write_text(json.dumps(hist[-500:], separators=(",", ":")))
    site["history"] = hist[-300:]
    (DATA / "site.json").write_text(json.dumps(site, ensure_ascii=False, separators=(",", ":")))
    seat_dir = DATA / "seat"
    seat_dir.mkdir(exist_ok=True)
    for s in seats:  # per-seat files carry the heavy booth tables
        (seat_dir / f"{s['slug']}.json").write_text(json.dumps(s, ensure_ascii=False, separators=(",", ":")))

    print(f"Analysed {sum(1 for s in seats if s['status']=='ok')}/88 seats; One Nation leading {ptp['on']}")


if __name__ == "__main__":
    main()
