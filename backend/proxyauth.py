"""Verify the gateway's request signature. Standard library only, no HTTP.

The host signs every proxied request with `X-KiroCrew-Proxy: <timestamp>:<hex signature>`. The
signature is HMAC-SHA256, keyed with the app's secret (`KIROCREW_PROXY_SECRET`), of
`timestamp:method:target:sha256(body)`, where `target` is the request target exactly as the backend
received it (path and query, without the app prefix). The timestamp is whole seconds and must be
within 60 seconds of now. This is the host's own rule (kiro_crew.apps.proxy_auth.verify_proxy_request),
written out here because the backend may not be able to import kiro_crew.
"""
import hashlib
import hmac

MAX_SKEW_SECONDS = 60


def verify(header, *, method, target, body, secret, now):
    """True only for a valid, fresh signature. Any malformed input is False and never raises."""
    try:
        if not secret or not header or ":" not in header:
            return False
        stamp, _, signature = header.partition(":")
        if not stamp.isascii() or not stamp.isdigit() or not signature:
            return False
        if abs(now - int(stamp)) > MAX_SKEW_SECONDS:
            return False
        digest = hashlib.sha256(body or b"").hexdigest()
        message = f"{stamp}:{method}:{target}:{digest}"
        expected = hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()
        # Compared as bytes: compare_digest raises on a str with a non-ASCII character, and the
        # header is chosen by the caller. surrogatepass lets a lone surrogate compare, not raise.
        return hmac.compare_digest(
            expected.encode("utf-8", "surrogatepass"), signature.encode("utf-8", "surrogatepass"))
    except Exception:
        return False
