"""GET /api/admin-signup-stats — refresh the admin signup snapshot on demand.

This runs through the shared Python API entrypoint (60 s max duration), not
/api/ai's Edge runtime: the full historical aggregation can take ~22 seconds.
The browser calls this only while the Signups tab is visible, no more than
once every five minutes. pg_cron job 13 remains disabled.
"""
import hmac
import json
import os
from http.server import BaseHTTPRequestHandler

from _supa_http import request as supabase_request


def _allowed_origin(origin):
    if not origin:
        return True
    return (
        origin in {
            "https://stocksaathi.co.in",
            "https://www.stocksaathi.co.in",
            "http://localhost:7348",
            "http://127.0.0.1:7348",
        }
        or (origin.startswith("https://") and origin.endswith(".vercel.app"))
    )


def _authorized(headers):
    expected = os.environ.get("ADMIN_TOKEN", "").strip()
    supplied = (headers.get("Authorization", "") or "").strip()
    if supplied.startswith("Bearer "):
        supplied = supplied[7:].strip()
    if not expected or not supplied:
        return False
    return hmac.compare_digest(supplied, expected)


def _send(self, status, payload, origin=""):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Cache-Control", "no-store")
    self.send_header("X-Content-Type-Options", "nosniff")
    if origin:
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)


def _supabase_headers():
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not key:
        raise RuntimeError("database_not_configured")
    return {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        if not _allowed_origin(origin):
            _send(self, 403, {"error": "forbidden_origin"})
            return
        self.send_response(204)
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("Origin", "")
        if not _allowed_origin(origin):
            _send(self, 403, {"error": "forbidden_origin"})
            return
        if not _authorized(self.headers):
            _send(self, 401, {"error": "unauthorized"}, origin)
            return

        try:
            headers = _supabase_headers()
            # This function takes the shared analytics advisory lock and
            # atomically replaces the snapshot. Cap network wait below the
            # Python function's configured 60-second maximum.
            refresh_code = None
            try:
                status, raw = supabase_request(
                    "POST",
                    "/rest/v1/rpc/refresh_admin_signup_stats",
                    body=b"{}",
                    headers=headers,
                    timeout=30.0,
                )
                if status == 200:
                    try:
                        refresh_code = int(json.loads(raw.decode("utf-8")))
                    except (ValueError, TypeError, json.JSONDecodeError):
                        refresh_code = None
            except Exception as exc:
                # A previously committed snapshot is still useful. The
                # response marks it as skipped so the browser retries later.
                print("[admin-signup-stats] refresh_failed", type(exc).__name__, flush=True)

            status, raw = supabase_request(
                "POST",
                "/rest/v1/rpc/admin_signup_stats_cached",
                body=b"{}",
                headers=headers,
                timeout=8.0,
            )
            if status < 200 or status >= 300:
                _send(self, 502, {"error": "signup_cache_unavailable", "status": status}, origin)
                return

            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("totals"), dict):
                _send(self, 502, {"error": "signup_cache_empty"}, origin)
                return

            # -1 means another scheduled analytics refresh owns the advisory
            # lock. A failed/timeout refresh also serves the last committed
            # snapshot, with a marker and computedAt for visible staleness.
            data["refreshSkipped"] = refresh_code is None or refresh_code < 0
            _send(self, 200, data, origin)
        except Exception as exc:
            print("[admin-signup-stats] request_failed", type(exc).__name__, flush=True)
            _send(self, 502, {"error": "signup_stats_failed"}, origin)

    def do_POST(self):
        _send(self, 405, {"error": "method_not_allowed"})
