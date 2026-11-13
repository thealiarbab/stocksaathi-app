"""/api/history: Yahoo saying "no such symbol" is a 404, not an outage.

handlers/history.py used to answer 502 yahoo_unreachable for every miss,
including Yahoo's fast HTTP 404 or empty chart for listings it does not
carry, so the error watcher counted normal "no data" answers as server errors.
"""

import importlib.util
import io
import pathlib
import socket
import sys
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "handlers"))
_spec = importlib.util.spec_from_file_location("history_handler", ROOT / "handlers" / "history.py")
history = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(history)


def _raise(exc):
    def _open(req, timeout=None):
        raise exc
    return _open


def _http(code):
    return urllib.error.HTTPError("u", code, "x", {}, None)


def _body(raw):
    def _open(req, timeout=None):
        return io.BytesIO(raw)
    return _open


def _fetch():
    return history.fetch_yahoo("NOSUCH", "1y", "1d")


def test_yahoo_404_everywhere_is_no_data(monkeypatch):
    monkeypatch.setattr(history.urllib.request, "urlopen", _raise(_http(404)))
    assert _fetch() == {"error": "no_data"}


def test_empty_result_is_no_data(monkeypatch):
    monkeypatch.setattr(history.urllib.request, "urlopen", _body(b'{"chart":{"result":null}}'))
    assert _fetch() == {"error": "no_data"}


def test_timeout_is_unreachable(monkeypatch):
    monkeypatch.setattr(history.urllib.request, "urlopen", _raise(socket.timeout()))
    assert _fetch() == {"error": "yahoo_unreachable"}


def test_429_or_5xx_is_unreachable(monkeypatch):
    for code in (429, 500, 503):
        monkeypatch.setattr(history.urllib.request, "urlopen", _raise(_http(code)))
        assert _fetch() == {"error": "yahoo_unreachable"}


def test_candles_still_returned(monkeypatch):
    raw = (b'{"chart":{"result":[{"meta":{"currency":"INR"},"timestamp":[1700000000],'
           b'"indicators":{"quote":[{"open":[10.5],"high":[11.25],"low":[10.0],"close":[11.0],"volume":[5]}]}}]}}')
    monkeypatch.setattr(history.urllib.request, "urlopen", _body(raw))
    out = _fetch()
    assert out["ohlc"][0]["c"] == 1100 and out["ticker"] == "NOSUCH.NS"
