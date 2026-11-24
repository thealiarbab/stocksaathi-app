"""FII/DII flows and the IPO list from NSE -> /api/admin-ingest-eod.

Run by .github/workflows/nse-eod.yml after the bhavcopy step. NSE blocks
Vercel, so a GitHub runner fetches and Vercel stores (same split as the
bhavcopy). The coach reads the result through coach_fii_dii() and
coach_ipo_calendar().

NSE's JSON endpoints answer only after a normal page visit has set its
cookies, and only to browser-like headers, so this opens a report page first
and reuses the cookie jar.

  python scripts/market_extras.py            fetch, then POST when CRON_SECRET is set
  python scripts/market_extras.py --print    fetch and print the payload only

Stdlib only.
"""
import datetime as dt
import gzip
import http.cookiejar
import json
import os
import sys
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
BASE = "https://www.nseindia.com"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

_jar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))


def _get(url, accept, referer=None, timeout=30):
    headers = {
        "User-Agent": UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip",
        "Connection": "keep-alive",
    }
    if referer:
        headers["Referer"] = referer
    else:
        headers.update({"Upgrade-Insecure-Requests": "1", "Sec-Fetch-Dest": "document",
                        "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none"})
    with _opener.open(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
        body = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
    return body.decode("utf-8", "replace")


def _api(path, referer):
    try:
        data = json.loads(_get(BASE + "/api/" + path, "application/json, text/plain, */*", referer))
        return data if isinstance(data, list) else []
    except Exception as e:  # one list failing must not lose the others
        print(f"  {path}: {e}")
        return []


def _date(s):
    """'23-Nov-2026' or '23-NOV-2026' -> '2026-11-23'; anything else -> None."""
    s = str(s or "").strip()
    if not s or s == "-":
        return None
    try:
        return dt.datetime.strptime(s.title(), "%d-%b-%Y").date().isoformat()
    except ValueError:
        return None


def _num(s):
    try:
        return float(str(s).replace(",", ""))
    except (TypeError, ValueError):
        return None


def fii_dii():
    by_day = {}
    for row in _api("fiidiiTradeReact", BASE + "/reports/fii-dii"):
        day = _date(row.get("date"))
        if not day:
            continue
        who = "fii" if "FII" in str(row.get("category", "")).upper() else "dii"
        rec = by_day.setdefault(day, {"trade_date": day})
        rec[who + "_buy_cr"] = _num(row.get("buyValue"))
        rec[who + "_sell_cr"] = _num(row.get("sellValue"))
        rec[who + "_net_cr"] = _num(row.get("netValue"))
    return list(by_day.values())


def ipos():
    ref = BASE + "/market-data/all-upcoming-issues-ipo"
    out = {}

    def add(symbol, company, board, status, opens, closes, band, shares, listing):
        symbol = str(symbol or "").strip().upper()
        if not symbol or not company:
            return
        out[symbol] = {
            "symbol": symbol, "company": str(company).strip()[:120],
            "board": "SME" if str(board or "").upper() == "SME" else "Mainboard",
            "status": str(status or "").strip()[:24] or None,
            "opens_on": _date(opens), "closes_on": _date(closes),
            "price_band": (str(band or "").strip()[:60] or None) if str(band or "").strip() != "-" else None,
            "shares_offered": int(_num(shares)) if _num(shares) else None,
            "listing_on": _date(listing),
        }

    cutoff = (dt.datetime.now(IST).date() - dt.timedelta(days=45)).isoformat()
    for r in _api("public-past-issues", ref):
        closes = _date(r.get("ipoEndDate"))
        if not closes or closes < cutoff:
            continue
        add(r.get("symbol"), r.get("company") or r.get("companyName"), r.get("securityType"), "Closed",
            r.get("ipoStartDate"), r.get("ipoEndDate"), r.get("priceRange") or r.get("issuePrice"), None, r.get("listingDate"))
    for path in ("all-upcoming-issues?category=ipo", "ipo-current-issue"):
        for r in _api(path, ref):
            add(r.get("symbol"), r.get("companyName") or r.get("company"), r.get("series"), r.get("status"),
                r.get("issueStartDate"), r.get("issueEndDate"), r.get("issuePrice"), r.get("issueSize"), None)
    return list(out.values())


def main():
    _get(BASE + "/reports/fii-dii", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
    payload = {"kind": "market_extras", "fii_dii": fii_dii(), "ipos": ipos()}
    print(f"fii_dii days: {len(payload['fii_dii'])}, ipos: {len(payload['ipos'])}")
    if "--print" in sys.argv:
        print(json.dumps(payload, separators=(",", ":")))
        return 0
    if not payload["fii_dii"] and not payload["ipos"]:
        print("::warning::NSE returned nothing for FII/DII and IPOs")
        return 0
    secret = os.environ.get("CRON_SECRET", "").strip()
    if not secret:
        print("CRON_SECRET not set: nothing sent")
        return 0
    req = urllib.request.Request(
        "https://stocksaathi.co.in/api/admin-ingest-eod", data=json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        print(r.read().decode("utf-8", "replace")[:400])
    return 0


if __name__ == "__main__":
    sys.exit(main())
