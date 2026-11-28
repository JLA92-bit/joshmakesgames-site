"""Seat projections and parliament simulation.

How a seat is projected
1. Preference model: an instant-runoff count is simulated on the current first preferences. Each excluded
   candidate's votes are passed on by origin party using PREF_SCORES (how much a party's voters like each
   other party). The result is a modelled two-candidate-preferred (2CP) result.
2. Real preference data: where the VEC has a 2CP count, it is blended in, weighted by how much of the
   vote it covers. Where booth-level 2CP lets us measure the actual flow, that measured flow wins.
3. Uncertainty shrinks as more of the roll is counted. A seat's win probability is the chance its
   projected margin holds, given that uncertainty.

The simulation then draws every seat thousands of times with shared statewide errors (so seats move
together like they do on a real night) to give odds for each path to power.
"""
from __future__ import annotations

import math
import random

# Relative appeal of each party to a voter of the row party. Only ratios matter. These reflect typical
# Australian preference patterns: Greens/Labor voters put One Nation last, Coalition voters prefer One
# Nation over Labor/Greens, minor-right voters lean One Nation/Coalition.
PREF_SCORES = {
    "GRN": {"GRN": 10, "ALP": 8, "IND": 5, "OTH": 4, "LIB": 2, "NAT": 2, "ON": 0.7},
    "ALP": {"ALP": 10, "GRN": 6, "IND": 4, "OTH": 3, "LIB": 2.5, "NAT": 2.5, "ON": 1},
    "LIB": {"LIB": 10, "NAT": 8, "ON": 4, "IND": 3, "OTH": 3, "ALP": 1.8, "GRN": 1},
    "NAT": {"NAT": 10, "LIB": 8, "ON": 4.5, "IND": 3, "OTH": 3, "ALP": 1.8, "GRN": 1},
    "ON":  {"ON": 10, "NAT": 4, "LIB": 3.5, "OTH": 3, "IND": 2.5, "ALP": 1.2, "GRN": 0.5},
    "IND": {"IND": 10, "OTH": 3, "GRN": 3, "ALP": 3, "LIB": 3, "NAT": 3, "ON": 2.2},
    "OTH": {"OTH": 10, "ON": 4, "LIB": 3.5, "NAT": 3.5, "IND": 3, "ALP": 2.2, "GRN": 1.8},
}

BLOCS = {"GRN": 0, "ALP": 1, "IND": 2, "OTH": 3, "LIB": 4, "NAT": 5, "ON": 6}  # left-to-right seating order


def irv(prim: list[dict], keep: set | None = None) -> list[dict]:
    """Simulate exclusions. prim: [{candidate, code, votes}]. Returns final two with modelled votes.
    keep: candidate names that must not be excluded (forces a particular final two)."""
    cands = [{"candidate": p["candidate"], "code": p["code"], "piles": {p["code"]: float(p["votes"])}}
             for p in prim if p["votes"] > 0]
    if len(cands) < 2:
        return []
    while len(cands) > 2:
        cands.sort(key=lambda c: (bool(keep) and c["candidate"] in keep, sum(c["piles"].values())), reverse=True)
        out = cands.pop()
        for origin, v in out["piles"].items():
            sc = PREF_SCORES.get(origin, PREF_SCORES["OTH"])
            w = [sc.get(c["code"], 3) * (0.98 if c["code"] == origin else 1) for c in cands]
            tot = sum(w)
            for c, wi in zip(cands, w):
                c["piles"][origin] = c["piles"].get(origin, 0) + v * wi / tot
    total = sum(sum(c["piles"].values()) for c in cands)
    res = [{"candidate": c["candidate"], "code": c["code"], "votes": sum(c["piles"].values())} for c in cands]
    for r in res:
        r["pct"] = 100 * r["votes"] / total
    return sorted(res, key=lambda r: -r["pct"])


def phi(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def project_seat(seat: dict, measured_flow: dict | None) -> dict | None:
    """Return projection dict for an analysed seat (see analyse.analyse_seat)."""
    prim = seat.get("primary") or []
    if seat.get("status") != "ok" or len(prim) < 2:
        return None
    if seat.get("elected"):
        w = seat["leader"]
        return {"winner": w, "win_prob": 1.0, "final": seat.get("tcp") or [], "basis": "declared", "sd": 0,
                "margin": None}
    model = irv(prim)
    vec = seat.get("tcp") or []
    if len(vec) == 2 and {v["candidate"] for v in vec} != {m["candidate"] for m in model}:
        # The VEC chose a different final two. Follow it unless the candidate it left out is clearly ahead.
        pv = {p["candidate"]: p["pct"] for p in prim}
        left_out = [m for m in model if m["candidate"] not in {v["candidate"] for v in vec}]
        weakest_vec = min(pv.get(v["candidate"], 0) for v in vec)
        if not left_out or pv.get(left_out[0]["candidate"], 0) - weakest_vec < 4:
            model = irv(prim, keep={v["candidate"] for v in vec})
    a, b = model[0], model[1]
    pa, basis = a["pct"], "preference model"
    names = {a["candidate"], b["candidate"]}
    if len(vec) == 2 and {v["candidate"] for v in vec} == names:
        va = next(v for v in vec if v["candidate"] == a["candidate"])["pct"]
        cover = min(1.0, (seat.get("tcp_share_counted") or 0) / 100)
        wgt = 0.25 + 0.6 * cover
        pa = wgt * va + (1 - wgt) * pa
        basis = "VEC preference count + model"
        if measured_flow is not None:  # share of 'other' votes flowing to finalist a
            others = 100 - next(p["pct"] for p in prim if p["candidate"] == a["candidate"]) - \
                next(p["pct"] for p in prim if p["candidate"] == b["candidate"])
            pf = next(p["pct"] for p in prim if p["candidate"] == a["candidate"]) + measured_flow * others
            pa = 0.7 * pf + 0.3 * pa
            basis = "measured preference flow"
    c = min(1.0, (seat.get("counted_pct") or 0) / 70)
    sd = 1.5 + 7 * (1 - c) + (0 if basis != "preference model" else 2.5)
    lead, trail = (a, b) if pa >= 50 else (b, a)
    lead_pct = max(pa, 100 - pa)
    margin = lead_pct - 50
    return {"winner": lead["code"], "win_prob": phi(margin / sd), "basis": basis, "sd": sd, "margin": margin,
            "final": [{"candidate": lead["candidate"], "code": lead["code"], "pct": lead_pct},
                      {"candidate": trail["candidate"], "code": trail["code"], "pct": 100 - lead_pct}]}


def simulate(seats: list[dict], progress: float, n: int = 4000, seed: int = 7) -> dict:
    """Monte Carlo over all 88 seats. progress: share of roll counted 0..1."""
    rng = random.Random(seed)
    rows = []
    for s in seats:
        p = s.get("projection")
        if not p:
            rows.append(None)
            continue
        a, b = p["final"][0], p["final"][1] if len(p["final"]) > 1 else {"code": "OTH", "pct": 0}
        rows.append((a["code"], b["code"], a["pct"], p["sd"], p["basis"] == "declared"))
    on_sd = 0.8 + 2.5 * (1 - progress)
    cl_sd = 0.6 + 2.0 * (1 - progress)
    keys = ["ON", "LIB", "NAT", "ALP", "GRN", "IND", "OTH"]
    tallies = {k: [] for k in keys}
    out = {"coalition_majority": 0, "on_kingmaker": 0, "on_majority": 0, "labor_majority": 0,
           "labor_with_greens": 0, "hung": 0, "on_leads_right": 0}
    for _ in range(n):
        z_on, z_cl = rng.gauss(0, on_sd), rng.gauss(0, cl_sd)
        t = dict.fromkeys(keys, 0)
        missing = 0
        for r in rows:
            if r is None:
                missing += 1
                continue
            ca, cb, pa, sd, done = r
            if not done:
                shift = 0.0
                if ca == "ON":
                    shift += z_on
                elif cb == "ON":
                    shift -= z_on
                if ca in ("LIB", "NAT") and cb in ("ALP", "GRN"):
                    shift += z_cl
                elif cb in ("LIB", "NAT") and ca in ("ALP", "GRN"):
                    shift -= z_cl
                pa = pa + shift + rng.gauss(0, sd)
            w = ca if pa >= 50 else cb
            t[w if w in t else "OTH"] += 1
        coal = t["LIB"] + t["NAT"]
        for k in keys:
            tallies[k].append(t[k])
        if t["ON"] >= 45:
            out["on_majority"] += 1
        elif coal >= 45:
            out["coalition_majority"] += 1
        elif coal + t["ON"] >= 45:
            out["on_kingmaker"] += 1
            if t["ON"] > coal:
                out["on_leads_right"] += 1
        elif t["ALP"] >= 45:
            out["labor_majority"] += 1
        elif t["ALP"] + t["GRN"] >= 45:
            out["labor_with_greens"] += 1
        else:
            out["hung"] += 1
    probs = {k: round(v / n, 3) for k, v in out.items()}

    def pctl(xs, q):
        xs = sorted(xs)
        return xs[min(len(xs) - 1, int(q * len(xs)))]
    seats_dist = {}
    for k in keys:
        xs = tallies[k]
        if max(xs) == 0:
            continue
        seats_dist[k] = {"mean": round(sum(xs) / n, 1), "p10": pctl(xs, 0.1), "p50": pctl(xs, 0.5),
                         "p90": pctl(xs, 0.9)}
    hist = {}
    for x in tallies["ON"]:
        hist[x] = hist.get(x, 0) + 1
    on_hist = [{"seats": k, "p": round(v / n, 3)} for k, v in sorted(hist.items())]
    return {"probs": probs, "seats": seats_dist, "on_hist": on_hist, "runs": n,
            "unprojected": sum(1 for r in rows if r is None)}


# ---------------------------------------------------------------- pre-count prior

# Share of each 2022 party's voters assumed to move to One Nation (relative weights, scaled so the
# statewide total matches the poll average). Puts One Nation's vote where Coalition, minor-right and
# disaffected Labor voters are, and keeps it low in Greens heartland.
ON_DRAW = {"LIB": 0.30, "NAT": 0.36, "ALP": 0.20, "GRN": 0.03, "IND": 0.25, "OTH": 0.40, "ON": 1.0}


def prior_tables(baseline: dict) -> dict:
    """Seat-level prior first preferences for 2026, from 2022 results + final poll average."""
    seats = baseline.get("seats", {})
    polls = baseline.get("poll_average", {})
    if not seats or not polls:
        return {}
    n = len(seats)
    s22 = {}
    for s in seats.values():
        for k, v in s["primary"].items():
            s22[k] = s22.get(k, 0) + v / n
    raw = {slug: sum(s["primary"].get(k, 0) * ON_DRAW.get(k, 0.3) for k in s["primary"]) for slug, s in seats.items()}
    raw_avg = sum(raw.values()) / n or 1
    k_on = polls["ON"] / raw_avg
    after = {}
    for slug, s in seats.items():
        p = {}
        for k, v in s["primary"].items():
            if k == "ON":
                continue
            p[k] = max(0.0, v * (1 - min(0.95, k_on * ON_DRAW.get(k, 0.3))))
        p["ON"] = min(60.0, k_on * raw[slug])
        after[slug] = p
    avg_after = {}
    for p in after.values():
        for k, v in p.items():
            avg_after[k] = avg_after.get(k, 0) + v / n
    coal22 = s22.get("LIB", 0) + s22.get("NAT", 0) or 1
    target = {"ALP": polls["ALP"], "GRN": polls["GRN"],
              "LIB": polls["COAL"] * s22.get("LIB", 0) / coal22, "NAT": polls["COAL"] * s22.get("NAT", 0) / coal22}
    rest = max(1.0, polls["OTHERS"])
    other_avg = sum(v for k, v in avg_after.items() if k in ("IND", "OTH")) or 1
    out = {}
    for slug, p in after.items():
        q = {}
        for k, v in p.items():
            if k == "ON":
                q[k] = v
            elif k in target and avg_after.get(k):
                q[k] = v * target[k] / avg_after[k]
            else:
                q[k] = v * rest / other_avg
        tot = sum(q.values()) or 1
        out[slug] = {k: round(100 * v / tot, 2) for k, v in q.items() if v > 0.05}
    return out


def project_prior(prior_prim: dict) -> dict | None:
    if not prior_prim:
        return None
    prim = [{"candidate": k, "code": k, "votes": v} for k, v in prior_prim.items()]
    fin = irv(prim)
    if len(fin) < 2:
        return None
    a, b = fin
    margin = a["pct"] - 50
    sd = 7.0
    return {"winner": a["code"], "win_prob": phi(margin / sd), "basis": "pre-count estimate", "sd": sd,
            "margin": margin, "final": [{"candidate": NAMES_FOR_PRIOR.get(a["code"], a["code"]), "code": a["code"],
                                         "pct": a["pct"]},
                                        {"candidate": NAMES_FOR_PRIOR.get(b["code"], b["code"]), "code": b["code"],
                                         "pct": b["pct"]}],
            "primary": prior_prim}


NAMES_FOR_PRIOR = {"ON": "One Nation", "LIB": "Liberal", "NAT": "Nationals", "ALP": "Labor", "GRN": "Greens",
                   "IND": "Independent", "OTH": "Other"}


def blend(live: dict | None, prior: dict | None, counted_pct: float | None) -> dict | None:
    """Lean on the pre-count estimate early, then on the live count as the roll is counted."""
    if not live:
        return prior
    if not prior or live.get("basis") == "declared":
        return live
    w = min(1.0, (counted_pct or 0) / 25) ** 0.7
    la, lb = live["final"][0], live["final"][1]
    pa_prior = next((f["pct"] for f in prior["final"] if f["code"] == la["code"]), None)
    pb_prior = next((f["pct"] for f in prior["final"] if f["code"] == lb["code"]), None)
    if pa_prior is None or pb_prior is None:  # different final two: real counts beat the estimate quickly
        if w >= 0.25 or "VEC" in live["basis"] or "measured" in live["basis"]:
            out = dict(live)
            out["sd"] = live["sd"] + (1 - w) * 3
            out["win_prob"] = phi(live["margin"] / out["sd"])
            out["live_weight"] = round(w, 2)
            return out
        return prior
    pa = w * la["pct"] + (1 - w) * pa_prior
    sd = w * live["sd"] + (1 - w) * prior["sd"]
    lead, trail = (la, lb) if pa >= 50 else (lb, la)
    lp = max(pa, 100 - pa)
    out = dict(live)
    out.update(winner=lead["code"], margin=lp - 50, sd=sd, win_prob=phi((lp - 50) / sd),
               final=[dict(lead, pct=lp), dict(trail, pct=100 - lp)],
               basis=live["basis"] if w > 0.85 else f"{live['basis']}, blended with pre-count estimate")
    out["live_weight"] = round(w, 2)
    return out
