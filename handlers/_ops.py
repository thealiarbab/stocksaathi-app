"""Error reporting to the outside watcher (edge/ops-watch on Cloudflare).

Every request served by the shim passes ``after()`` on its way out. A healthy
request costs one counter update under a lock and nothing else. A failed one
(an exception, a 5xx reply, or a user-facing call slower than 10 s) produces
one small report, sent with a 300 ms cap, and can never change the reply.
About every 10 minutes one request per instance also carries the request
counts, so the watcher knows what share of calls fail. Nothing here touches
the database. Stdlib only.

Off switch: OPS_WATCH=0. Unset OPS_WATCH_URL / OPS_WATCH_SECRET also means off.
"""

import hashlib
import hmac
import json
import os
import threading
import time
import traceback
import urllib.request

_URL = os.environ.get("OPS_WATCH_URL", "").strip().rstrip("/")
_SECRET = os.environ.get("OPS_WATCH_SECRET", "").strip()
_ON = bool(_URL and _SECRET) and os.environ.get("OPS_WATCH", "1").strip() != "0"
_DEPLOY = (os.environ.get("VERCEL_GIT_COMMIT_SHA", "") or "")[:7] or None
_REGION = os.environ.get("VERCEL_REGION", "") or None

SLOW_MS = 10_000
TALLY_EVERY_S = 600
MAX_PER_MIN = 20
# Batch jobs run for a long time by design; only user-facing calls are judged
# on speed.
_SLOW_EXEMPT = ("admin-", "match-orders", "fill-email", "weekly-report", "email-status")

_lock = threading.Lock()
_tally = {}
_tally_since = time.time()
_win = [0.0, 0]
_HERE = os.path.dirname(os.path.abspath(__file__))


def secret_matches(value):
    return bool(_ON and value) and hmac.compare_digest(str(value), _SECRET)


def _frames(exc):
    """Our own code on the way to the error, innermost first, as file:function
    (no line numbers: they move on every edit)."""
    out = []
    for f in reversed(traceback.extract_tb(exc.__traceback__)):
        name = f.filename.replace("\\", "/")
        if "site-packages" in name or "/lib/python" in name:
            continue
        if name.startswith(_HERE.replace("\\", "/")):
            name = "handlers" + name[len(_HERE):]
        else:
            name = name.rsplit("/", 2)[-2] + "/" + name.rsplit("/", 1)[-1] if "/" in name else name
        out.append(f"{name}:{f.name}")
        if len(out) >= 8:
            break
    return out


def _who(ip):
    if not ip:
        return None
    day = time.strftime("%Y-%m-%d", time.gmtime())
    return hashlib.sha256(f"{ip}|{day}|{_SECRET}".encode()).hexdigest()[:12]


def _take_tally(force=False):
    global _tally, _tally_since
    if not _tally or (not force and time.time() - _tally_since < TALLY_EVERY_S):
        return None
    out, _tally, _tally_since = _tally, {}, time.time()
    return out


def after(stem, method, status, ms, exc=None, body=None, ip=None, canary=False):
    """Count one finished request. Returns a payload to send, or None (the
    normal case). Fast: call inline."""
    if not _ON:
        return None
    route = "/api/" + stem
    failed = exc is not None or status >= 500
    events = []
    with _lock:
        row = _tally.setdefault(route, [0, 0, 0])
        row[1 if failed else 0] += 1
        row[2] += int(ms)
        slow = (not failed and ms >= SLOW_MS and not stem.startswith(_SLOW_EXEMPT))
        if failed or slow:
            now = time.time()
            if now - _win[0] > 60:
                _win[0], _win[1] = now, 0
            _win[1] += 1
            if _win[1] > MAX_PER_MIN:      # storm guard: counted, not sent one by one
                failed = slow = False
        tally = _take_tally(force=canary)
    if failed or slow:
        ev = {"t": int(time.time() * 1000), "route": route, "method": method, "status": 500 if exc is not None else status,
              "ms": int(ms), "who": _who(ip), "region": _REGION}
        if exc is not None:
            ev.update(kind="exception", etype=type(exc).__name__, msg=str(exc)[:300], frames=_frames(exc))
        elif failed:
            ev["kind"] = "http5xx"
            try:
                text = bytes(body or b"")[:400].decode("utf-8", "replace")
                ev["body"] = text
                parsed = json.loads(bytes(body)) if body and len(body) < 4000 else None
                if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
                    ev["code"] = parsed["error"][:60]
            except Exception:
                pass
        else:
            ev["kind"] = "slow"
        events.append(ev)
        try:
            print("OPS_EVT " + json.dumps(ev, default=str), flush=True)
        except Exception:
            pass
    if canary:
        events.append({"kind": "canary", "t": int(time.time() * 1000)})
    if not events and not tally:
        return None
    return {"src": "py", "deploy": _DEPLOY, "tally": tally, "events": events}


def send(payload, timeout=0.3):
    """Blocking, at most `timeout` seconds. Run it off the event loop."""
    try:
        req = urllib.request.Request(
            _URL + "/e", data=json.dumps(payload, default=str).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + _SECRET,
                     "User-Agent": "StockSaathi-Ops/1"},
            method="POST")
        urllib.request.urlopen(req, timeout=timeout).close()
    except Exception:
        pass      # reporting must never break a reply
