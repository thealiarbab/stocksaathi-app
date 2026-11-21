"""/api/quote: Yahoo saying "no such symbol" is a 404, not an outage.

handlers/quote.py used to answer 502 yahoo_unreachable for every miss,
including Yahoo's fast HTTP 404 for listings it does not carry, so the
error watcher counted normal "no price" answers as server errors.
"""

import importlib.util
import pathlib
import socket
import sys
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "handlers"))
_spec = importlib.util.spec_from_file_location("quote_handler", ROOT / "handlers" / "quote.py")
quote = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(quote)


def _raise(exc):
    def _get(url, headers, timeout):
        raise exc
    return _get


def _http(code):
    return urllib.error.HTTPError("u", code, "x", {}, None)


def test_yahoo_404_everywhere_is_no_data(monkeypatch):
    monkeypatch.setattr(quote, "yahoo_get", _raise(_http(404)))
    assert quote.fetch_one("NOSUCH")["error"] == "no_data"


def test_empty_result_is_no_data(monkeypatch):
    monkeypatch.setattr(quote, "yahoo_get", lambda u, h, t: b'{"chart":{"result":null}}')
    assert quote.fetch_one("NOSUCH")["error"] == "no_data"


def test_timeout_is_unreachable(monkeypatch):
    monkeypatch.setattr(quote, "yahoo_get", _raise(socket.timeout()))
    assert quote.fetch_one("RELIANCE")["error"] == "yahoo_unreachable"


def test_429_or_5xx_is_unreachable(monkeypatch):
    for code in (429, 500, 503):
        monkeypatch.setattr(quote, "yahoo_get", _raise(_http(code)))
        assert quote.fetch_one("RELIANCE")["error"] == "yahoo_unreachable"


def test_error_names_the_symbol(monkeypatch):
    monkeypatch.setattr(quote, "yahoo_get", _raise(socket.timeout()))
    assert quote.fetch_one("RELIANCE")["symbol"] == "RELIANCE"


def test_timeout_tries_one_host_per_ticker(monkeypatch):
    calls = []

    def _get(url, headers, timeout):
        calls.append(url)
        raise socket.timeout()
    monkeypatch.setattr(quote, "yahoo_get", _get)
    quote.fetch_one("RELIANCE")
    # .NS and .BO, one host each: worst case 2 x 8 s, not 4 x 8 s.
    assert len(calls) == 2


def test_429_still_tries_the_other_host(monkeypatch):
    calls = []

    def _get(url, headers, timeout):
        calls.append(url)
        raise _http(429)
    monkeypatch.setattr(quote, "yahoo_get", _get)
    quote.fetch_one("RELIANCE")
    assert len(calls) == 4
