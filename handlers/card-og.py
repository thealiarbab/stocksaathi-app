"""
GET /api/card-og?t=<token>  ->  the 1200 x 630 PNG a report card link shows
as its preview (WhatsApp, X, Telegram).

The picture is drawn as an SVG by the edge function (api/ai.js,
op=card-og-svg), which shares the card art with the site. This handler only
turns that SVG into a PNG, because link previews do not accept SVG. The SVG is
fetched from our own site, never from the caller, so a preview can only ever
show a card the server scored.

Fonts: handlers/fonts/Inter-*.ttf are static cuts of the site's Inter (the
renderer cannot read the variable woff2 the pages use).
"""

from http.server import BaseHTTPRequestHandler
import pathlib
import re
import urllib.parse
import urllib.request

_TOKEN = re.compile(r"^[a-z0-9]{12}$")
_FONTS = [str(p) for p in sorted((pathlib.Path(__file__).resolve().parent / "fonts").glob("Inter-*.ttf"))]
_ORIGIN = "https://stocksaathi.co.in"


def _svg_for(token):
    req = urllib.request.Request(
        f"{_ORIGIN}/api/ai?op=card-og-svg&t={token}",
        headers={"User-Agent": "StockSaathi-card-og/1"},
    )
    with urllib.request.urlopen(req, timeout=8) as r:  # raises HTTPError on 404/503
        return r.read().decode("utf-8")


def render_png(svg):
    import resvg_py  # imported here so the other routes never pay for loading it

    return bytes(resvg_py.svg_to_bytes(
        svg_string=svg, width=1200, height=630,
        font_files=_FONTS, skip_system_fonts=True, font_family="Inter", sans_serif_family="Inter",
    ))


class handler(BaseHTTPRequestHandler):
    def _send(self, status, body=b"", ctype="text/plain; charset=utf-8", cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Robots-Tag", "noindex")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        token = (q.get("t") or [""])[0]
        if not _TOKEN.match(token):
            return self._send(404, b"not found")
        try:
            svg = _svg_for(token)
        except urllib.error.HTTPError as e:
            return self._send(404 if e.code == 404 else 502, b"not found" if e.code == 404 else b"unavailable")
        except Exception:
            return self._send(502, b"unavailable")
        try:
            png = render_png(svg)
        except Exception:
            return self._send(500, b"render failed")
        # The address carries the marks and grade (&v=), so a changed card is a new address.
        self._send(200, png, "image/png", "public, max-age=3600, s-maxage=86400")

    def log_message(self, *a, **k):
        pass
