import hashlib
import hmac
import unittest

from proxyauth import verify

SECRET = "s3cret-value"
NOW = 1_800_000_000


def sign(stamp, method, target, body, secret=SECRET):
    digest = hashlib.sha256(body).hexdigest()
    mac = hmac.new(secret.encode(), f"{stamp}:{method}:{target}:{digest}".encode(), hashlib.sha256).hexdigest()
    return f"{stamp}:{mac}"


def check(header, method="POST", target="/api/chats", body=b'{"card_id": "x"}', secret=SECRET, now=NOW):
    return verify(header, method=method, target=target, body=body, secret=secret, now=now)


class VerifyTests(unittest.TestCase):
    def test_valid_signature(self):
        self.assertTrue(check(sign(NOW, "POST", "/api/chats", b'{"card_id": "x"}')))

    def test_valid_with_a_query_and_a_non_ascii_body(self):
        body = '{"card_id": "e.md#Début"}'.encode()
        header = sign(NOW, "POST", "/api/chats?a=1&b=two%20words", body)
        self.assertTrue(check(header, target="/api/chats?a=1&b=two%20words", body=body))

    def test_empty_body_and_other_methods(self):
        for method in ("GET", "DELETE"):
            self.assertTrue(check(sign(NOW, method, "/api/chats", b""), method=method, body=b""))

    def test_window_is_sixty_seconds_in_both_directions(self):
        for offset, expected in ((0, True), (59, True), (60, True), (61, False), (-59, True), (-60, True), (-61, False)):
            stamp = NOW - offset
            self.assertEqual(check(sign(stamp, "POST", "/api/chats", b'{"card_id": "x"}')), expected, offset)

    def test_wrong_method_target_body_or_secret(self):
        header = sign(NOW, "POST", "/api/chats", b'{"card_id": "x"}')
        self.assertFalse(check(header, method="DELETE"))
        self.assertFalse(check(header, target="/api/chats/other"))
        self.assertFalse(check(header, target="/api/chats?x=1"))
        self.assertFalse(check(header, body=b'{"card_id": "y"}'))
        self.assertFalse(check(header, secret="another-secret"))

    def test_a_signature_for_an_empty_body_does_not_cover_a_body(self):
        header = sign(NOW, "POST", "/api/chats", b"")
        self.assertTrue(check(header, body=b""))
        self.assertFalse(check(header, body=b"{}"))

    def test_empty_secret_empty_header_no_colon(self):
        header = sign(NOW, "POST", "/api/chats", b'{"card_id": "x"}')
        self.assertFalse(check(header, secret=""))
        self.assertFalse(check(""))
        self.assertFalse(check(None))
        self.assertFalse(check(str(NOW)))

    def test_bad_timestamp_or_signature_part(self):
        mac = sign(NOW, "POST", "/api/chats", b'{"card_id": "x"}').split(":")[1]
        for header in (f"abc:{mac}", f"-{NOW}:{mac}", f"{NOW}.5:{mac}", f" {NOW}:{mac}", f"{NOW}:", f":{mac}",
                       f"{NOW}:{mac.upper()}", f"{NOW}:{mac[:-1]}", f"{NOW}:{mac}0", "٣٤٥:" + mac):
            self.assertFalse(check(header), header)

    def test_non_ascii_and_lone_surrogate_signatures_give_false(self):
        for header in (f"{NOW}:é", f"{NOW}:\udcff", f"{NOW}:" + "é" * 64, f"{NOW}:\ud800abc"):
            self.assertFalse(check(header), repr(header))

    def test_non_string_header_gives_false(self):
        for header in (123, b"1:2", [], {}):
            self.assertFalse(check(header))


if __name__ == "__main__":
    unittest.main()
