"""One ephemeral HTTP session, bounded NDJSON frames, no login-cookie access or browser."""
import base64
import json
import re
import resource
import sys
import time
from urllib.parse import parse_qs, urlparse, unquote, urljoin

MAX_BYTES = 2 * 1024 * 1024
MAX_FRAME = 8192
MAX_REQUESTS = 160


def redirect_code(location, requested_url):
    """A note-specific platform error is held separately; auth/challenges still stop all work."""
    original = urlparse(requested_url)
    target = urlparse(urljoin(requested_url, location))
    query = parse_qs(target.query, keep_blank_values=True)
    note_id = original.path.rstrip('/').split('/')[-1]
    if (target.scheme == 'https' and target.hostname == original.hostname
            and not target.port and not target.username and not target.password
            and target.path == '/website-login/captcha'):
        return 'SOURCE_VERIFICATION_REQUIRED'
    if (target.scheme == 'https' and target.hostname == original.hostname
            and not target.port and not target.username and not target.password
            and target.path == '/explore'
            and set(query).issubset({'source','xhsshare','xsec_token','xsec_source','target_note_id','undertake_note_error'})
            and all(len(values) == 1 for values in query.values())
            and query.get('target_note_id') == [note_id]
            and len(query.get('undertake_note_error', [])) == 1
            and unquote(query['undertake_note_error'][0]) == '该内容暂时无法查看'):
        return 'SOURCE_NOTE_UNAVAILABLE'
    return 'SOURCE_REDIRECT'


def checked_request(value):
    if not isinstance(value, dict) or set(value) != {"id", "url", "maxBytes"}:
        raise ValueError("XHS_HTTP_FRAME_INVALID")
    if not isinstance(value["id"], int) or isinstance(value["id"], bool) or value["id"] < 1:
        raise ValueError("XHS_HTTP_FRAME_INVALID")
    if not isinstance(value["url"], str) or len(value["url"]) > 4096:
        raise ValueError("XHS_HTTP_LINK_INVALID")
    url = urlparse(value["url"])
    query = parse_qs(url.query, keep_blank_values=True)
    if url.scheme != "https" or url.hostname != "www.xiaohongshu.com" or url.port or url.username or url.password or url.fragment:
        raise ValueError("XHS_HTTP_LINK_INVALID")
    if not re.fullmatch(r"/(?:explore|discovery/item|user/profile/[a-f0-9]{24})/[a-f0-9]{24}/?", url.path):
        raise ValueError("XHS_HTTP_LINK_INVALID")
    if any(key not in {"source", "xhsshare", "xsec_token", "xsec_source"} or len(items) != 1 for key, items in query.items()):
        raise ValueError("XHS_HTTP_LINK_INVALID")
    if not re.fullmatch(r"[A-Za-z0-9_=-]{16,255}", (query.get("xsec_token") or [""])[0]):
        raise ValueError("XHS_HTTP_LINK_INVALID")
    if not isinstance(value["maxBytes"], int) or isinstance(value["maxBytes"], bool) or not 1 <= value["maxBytes"] <= MAX_BYTES:
        raise ValueError("XHS_HTTP_FRAME_INVALID")
    return value


def get_page(session, request):
    started = time.monotonic()
    result = {"id": request["id"], "status": None, "code": None, "bodyBase64": None,
              "responseBytes": 0, "elapsedMs": 0, "retryAfter": None, "serverDate": None,
              "cpuMs": 0, "peakRssBytes": 0}
    response = None
    try:
        response = session.get(request["url"], timeout=15, allow_redirects=False, stream=True, verify=True,
                               headers={"Accept": "text/html,application/xhtml+xml", "Accept-Language": "zh-CN,zh;q=0.9"})
        status = result["status"] = response.status_code
        result["retryAfter"] = (response.headers.get("retry-after") or "")[:256] or None
        result["serverDate"] = (response.headers.get("date") or "")[:128] or None
        if 300 <= status <= 399:
            raise ValueError(redirect_code(response.headers.get('location') or '', request['url']))
        if status in (401, 403, 412, 461, 471):
            raise ValueError("SOURCE_BLOCKED")
        if status == 429:
            raise ValueError("RATE_LIMITED")
        if 500 <= status <= 599:
            raise ValueError("SOURCE_TEMPORARY_ERROR")
        if status != 200:
            raise ValueError("SOURCE_HTTP_ERROR")
        if "html" not in response.headers.get("content-type", "").lower():
            raise ValueError("PAGE_TYPE_INVALID")
        body = bytearray()
        for chunk in response.iter_content(chunk_size=65536):
            result["responseBytes"] += len(chunk)
            if result["responseBytes"] > request["maxBytes"]:
                raise ValueError("PAGE_TOO_LARGE")
            body.extend(chunk)
        result["bodyBase64"] = base64.b64encode(body).decode("ascii")
    except ValueError as error:
        result["code"] = str(error) if re.fullmatch(r"[A-Z][A-Z_]{0,63}", str(error)) else "XHS_HTTP_SOURCE_ERROR"
    except Exception as error:
        code = getattr(error, "code", None)
        result["code"] = "SOURCE_TIMEOUT" if code == 28 else "SOURCE_TLS_ERROR" if code in (35, 51, 58, 60, 77) else "SOURCE_NETWORK_ERROR"
    finally:
        if response is not None:
            response.close()
        result["elapsedMs"] = round((time.monotonic() - started) * 1000, 3)
        result["cpuMs"] = round(time.process_time() * 1000, 3)
        result["peakRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    return result


def main():
    from curl_cffi.requests import Session
    requests = 0
    with Session(impersonate="chrome146", verify=True, trust_env=False) as session:
        while True:
            raw = sys.stdin.buffer.readline(MAX_FRAME + 1)
            if not raw:
                return
            if len(raw) > MAX_FRAME or not raw.endswith(b"\n") or requests >= MAX_REQUESTS:
                raise ValueError("XHS_HTTP_FRAME_INVALID")
            request = checked_request(json.loads(raw))
            requests += 1
            result = get_page(session, request)
            sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n")
            sys.stdout.flush()
            if result["code"] and result["code"] != 'SOURCE_NOTE_UNAVAILABLE':
                return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No exception text: curl/import errors can include a locator or filesystem path.
        sys.exit(1)
