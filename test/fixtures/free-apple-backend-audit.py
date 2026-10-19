"""Local backend acceptance probes; never contact Apple or use real credentials.

Run: python test/fixtures/free-apple-backend-audit.py
Requires cryptography. Optional installed anisette compatibility checks run when
anisette is importable (CAPMAC_AUDIT_ANISETTE_PATH may point to an isolated install).
Failures deliberately describe unmet acceptance conditions in the audited code.
"""
from __future__ import annotations

import ast
import base64
import datetime as dt
import email.message
import gzip
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import plistlib
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile
import zlib

from cryptography import x509
from cryptography.hazmat.primitives import hashes, padding, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import pkcs12

if os.environ.get("CAPMAC_AUDIT_ANISETTE_PATH"):
    sys.path.insert(0, os.environ["CAPMAC_AUDIT_ANISETTE_PATH"])

SOURCE = Path(__file__).resolve().parents[2] / "packages/core/src/engine/wsl/free/apple-free.py"
backend = types.ModuleType("capmac_free_audit_subject")
exec(compile(SOURCE.read_text(encoding="utf-8"), str(SOURCE), "exec"), backend.__dict__)


class FakeAnisette:
    def headers(self):
        return {}


class Response:
    def __init__(self, body: bytes, headers=None, status=200):
        self.body, self.headers, self.status = body, headers or {}, status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self.body


def make_cert(key, days=365):
    now = dt.datetime.now(dt.timezone.utc)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "Audit only")])
    return (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(1234)
            .not_valid_before(now - dt.timedelta(minutes=1))
            .not_valid_after(now + dt.timedelta(days=days)).sign(key, hashes.SHA256()))


class CertificateService:
    def __init__(self, listed=None):
        self.listed = listed or []
        self.calls = []

    def api(self, method, path, **kwargs):
        self.calls.append((method, path))
        if method == "GET" and path == "/v1/certificates":
            return {"data": self.listed}
        if method == "DELETE":
            return {}
        if method == "POST" and path == "/v1/certificates":
            csr = x509.load_pem_x509_csr(kwargs["attributes"]["csrContent"].encode())
            issuer_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            now = dt.datetime.now(dt.timezone.utc)
            cert = (x509.CertificateBuilder().subject_name(csr.subject).issuer_name(csr.subject)
                    .public_key(csr.public_key()).serial_number(1234).not_valid_before(now)
                    .not_valid_after(now + dt.timedelta(days=365)).sign(issuer_key, hashes.SHA256()))
            return {"data": {"id": "NEW_DEV", "attributes": {"serialNumber": "04D2",
                    "certificateContent": base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode()}}}
        raise AssertionError((method, path, kwargs))


SRP_N = int(
    "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13"
    "DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93"
    "B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6"
    "481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E5"
    "7AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525"
    "F54759B65E372FCD68EF20FA7111F9E4AFF73", 16)


def headerless(value) -> bytes:
    """What Apple's encrypted replies decrypt to: a bare <dict> with no XML declaration or <plist>."""
    xml = plistlib.dumps(value)
    return xml[xml.index(b"<dict>"):xml.rindex(b"</dict>") + len(b"</dict>")]


class FakeGrandSlam:
    """Apple's side of the GrandSlam SRP sign-in, worked out independently of the client.

    Each sign-in answers with the next of `replies`, encrypted the way Apple does (AES-CBC, keys
    HMAC'd from the session key) and covered by M2 and np, plus the matching outer Status.
    """

    def __init__(self, username, password, replies, statuses=None, key_label=b"extra data key:"):
        digest = lambda data: hashlib.sha256(data).digest()
        self.username, self.salt, self.rounds = username.lower(), bytes(range(16)), 1000
        passkey = hashlib.pbkdf2_hmac("sha256", digest(password.encode()), self.salt, self.rounds, 32)
        self.verifier = pow(2, int.from_bytes(digest(self.salt + digest(b":" + passkey)), "big"), SRP_N)
        self.replies, self.statuses = list(replies), list(statuses or [{} for _ in replies])
        self.key_label, self.secret, self.sign_ins = key_label, int.from_bytes(bytes(range(32, 64)), "big"), 0

    def operation(self, params):
        digest = lambda data: hashlib.sha256(data).digest()
        raw = lambda value: value.to_bytes((value.bit_length() + 7) // 8, "big")
        pad = lambda value: value.to_bytes(256, "big")
        if params["o"] == "init":
            self.client_public = params["A2k"]
            multiplier = int.from_bytes(digest(pad(SRP_N) + pad(2)), "big")
            self.server_public = (multiplier * self.verifier + pow(2, self.secret, SRP_N)) % SRP_N
            return {"sp": "s2k", "c": "cookie", "s": self.salt, "i": self.rounds, "B": raw(self.server_public),
                    "Status": {"ec": 0}}
        assert params["o"] == "complete" and params["c"] == "cookie"
        a = int.from_bytes(self.client_public, "big")
        scrambler = int.from_bytes(digest(pad(a) + pad(self.server_public)), "big")
        key = digest(raw(pow((a * pow(self.verifier, scrambler, SRP_N)) % SRP_N, self.secret, SRP_N)))
        xor = bytes(p ^ q for p, q in zip(digest(pad(2)), digest(raw(SRP_N))))
        m1 = digest(xor + digest(self.username.encode()) + self.salt + self.client_public
                    + raw(self.server_public) + key)
        if params["M1"] != m1:
            raise backend.GsaError("Your Apple ID or password was entered incorrectly.", -22406)
        padder = padding.PKCS7(128).padder()
        body = padder.update(self.replies.pop(0)) + padder.finalize()
        encryptor = Cipher(algorithms.AES(hmac.new(key, self.key_label, hashlib.sha256).digest()),
                           modes.CBC(hmac.new(key, b"extra data iv:", hashlib.sha256).digest()[:16])).encryptor()
        spd = encryptor.update(body) + encryptor.finalize()
        transcript = b"s2k,s2k_fo" + b"|" + b"|" + b"s2k" + b"|" + struct.pack("<I", len(spd)) + spd + b"|" + b"|"
        mac_key = hmac.new(key, b"HMAC key:", hashlib.sha256).digest()
        self.sign_ins += 1
        return {"M2": digest(self.client_public + m1 + key), "spd": spd,
                "np": hmac.new(mac_key, digest(transcript), hashlib.sha256).digest(),
                "Status": {"ec": 0, **self.statuses.pop(0)}}


class BackendAcceptance(unittest.TestCase):
    def test_python_source_compiles(self):
        ast.parse(SOURCE.read_text(encoding="utf-8"))

    def test_srp_s2k_and_legacy_match_independent_server(self):
        # SRP server computes S=(A*v**u)**b, independent of the client's private exponent path.
        # Group is RFC 5054's 2048-bit group; Apple uses SHA256 and a PBKDF2 password key.
        n = int("""AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13
DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93
B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6
481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E5
7AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525
F54759B65E372FCD68EF20FA7111F9E4AFF73""".replace("\n", ""), 16)
        digest = lambda data: hashlib.sha256(data).digest()
        raw = lambda value: value.to_bytes((value.bit_length() + 7) // 8, "big")
        pad = lambda value: value.to_bytes(256, "big")
        salt, rounds = bytes.fromhex("00112233445566778899aabbccddeeff"), 1000
        username, password = "audit@example.invalid", "Synthetic test password"
        server_b = int.from_bytes(bytes(range(32, 64)), "big")
        multiplier = int.from_bytes(digest(pad(n) + pad(2)), "big")
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                with patch.object(backend.secrets, "token_bytes", return_value=bytes(range(1, 33))):
                    client = backend.SRPClient()
                password_hash = digest(password.encode())
                material = password_hash.hex().encode() if legacy else password_hash
                passkey = hashlib.pbkdf2_hmac("sha256", material, salt, rounds, 32)
                x = int.from_bytes(digest(salt + digest(b":" + passkey)), "big")
                verifier = pow(2, x, n)
                server_public = (multiplier * verifier + pow(2, server_b, n)) % n
                a_raw, b_raw = client.public_key(), raw(server_public)
                a_public = int.from_bytes(a_raw, "big")
                scrambler = int.from_bytes(digest(pad(a_public) + pad(server_public)), "big")
                secret = pow((a_public * pow(verifier, scrambler, n)) % n, server_b, n)
                server_key = digest(raw(secret))
                xor = bytes(a ^ b for a, b in zip(digest(pad(2)), digest(raw(n))))
                expected_m1 = digest(xor + digest(username.encode()) + salt + a_raw + b_raw + server_key)
                m1 = client.process_challenge(username, password, salt, rounds, legacy, b_raw)
                self.assertEqual(m1, expected_m1)
                self.assertTrue(client.verify_hamk(digest(a_raw + expected_m1 + server_key)))
                self.assertFalse(client.verify_hamk(b"wrong server"))
                client.add_string("s2k,s2k_fo")
                client.add_data(b"encrypted transcript")
                transcript = b"s2k,s2k_fo" + struct.pack("<I", 20) + b"encrypted transcript"
                mac_key = hmac.new(server_key, b"HMAC key:", hashlib.sha256).digest()
                self.assertTrue(client.verify_neg_proto(hmac.new(mac_key, digest(transcript), hashlib.sha256).digest()))

    def test_load_plist_reads_every_reply_shape(self):
        value = {"adsid": "000000-00-audit", "sk": b"\x00\x01"}
        xml = plistlib.dumps(value)
        for name, data in (("plistlib's own XML", xml), ("binary", plistlib.dumps(value, fmt=plistlib.FMT_BINARY)),
                           ("bare <dict>, as in Apple's encrypted replies", headerless(value)),
                           ("whitespace before the declaration", b"\n  " + xml),
                           ("whitespace before <plist>", b"\n" + xml[xml.index(b"<plist"):])):
            with self.subTest(name):
                self.assertEqual(backend.load_plist(data), value)
        with self.assertRaises(plistlib.InvalidFileException):
            backend.load_plist(b"\x93 not a plist")

    def test_sign_in_reads_apples_headerless_reply_through_two_factor(self):
        # The first live sign-in (2026-10-19) passed M2 and np, then plistlib refused the bare <dict>.
        login = {"adsid": "000000-00-audit", "GsIdmsToken": "audit-idms", "sk": bytes(32), "c": b"audit cookie"}
        for name, first, status in (
            ("status-code 409 in the reply (xtool)", {**login, "status-code": 409, "url": "trustedDeviceSecondaryAuth"}, {}),
            ("Status.au outside it (pypush, AltSign)", {**login, "status-code": 200}, {"au": "trustedDeviceSecondaryAuth"}),
        ):
            with self.subTest(name):
                server = FakeGrandSlam("Audit@Example.invalid", "Synthetic test password",
                                       [headerless(first), headerless({**login, "status-code": 200})], [status, {}])
                gsa = backend.GrandSlamClient(FakeAnisette())
                gsa._operation = server.operation
                asked = []
                gsa._two_factor = lambda found, route, get_code: asked.append((found, route))
                result = gsa.authenticate("Audit@Example.invalid", "Synthetic test password", lambda *_: "000000")
                self.assertEqual(asked, [({"adsid": "000000-00-audit", "GsIdmsToken": "audit-idms"}, "trusted")])
                self.assertEqual(result, login)
                self.assertEqual(server.sign_ins, 2)

    def test_sign_in_says_when_the_reply_does_not_decrypt(self):
        server = FakeGrandSlam("audit@example.invalid", "Synthetic test password",
                               [headerless({"adsid": "a"})], key_label=b"a different key:")
        gsa = backend.GrandSlamClient(FakeAnisette())
        gsa._operation = server.operation
        with patch.object(backend.secrets, "token_bytes", return_value=bytes(range(1, 33))):
            with self.assertRaisesRegex(backend.GsaError, "could not be decrypted"):
                gsa.authenticate("audit@example.invalid", "Synthetic test password", lambda *_: "000000")

    def test_sign_in_names_missing_fields(self):
        server = FakeGrandSlam("audit@example.invalid", "Synthetic test password",
                               [headerless({"adsid": "a", "GsIdmsToken": "t", "status-code": 200})])
        gsa = backend.GrandSlamClient(FakeAnisette())
        gsa._operation = server.operation
        with self.assertRaisesRegex(backend.GsaError, "missing sk, c"):
            gsa.authenticate("audit@example.invalid", "Synthetic test password", lambda *_: "000000")

    def test_second_factor_route_reads_every_signal(self):
        route = backend.second_factor_route
        self.assertEqual(route({}, {"au": "trustedDeviceSecondaryAuth"}), "trusted")
        self.assertEqual(route({}, {"au": "secondaryAuth"}), "sms")
        self.assertEqual(route({"status-code": 200}, {"au": "repair"}), None)  # no two-factor on the account
        self.assertEqual(route({}, {"hsc": 409}), "trusted")  # Apple already sent a code (isideload)
        self.assertEqual(route({"status-code": 409, "url": "trustedDeviceSecondaryAuth"}, {}), "trusted")  # xtool
        self.assertEqual(route({"status-code": 409, "url": "secondaryAuth"}, {}), "sms")
        self.assertEqual(route({"status-code": 409}, {}), "trusted")
        self.assertEqual(route({"status-code": 200}, {"hsc": 200}), None)

    def _two_factor_client(self, answers):
        """A GrandSlam client whose requests are recorded and answered from `answers` (bytes or an error)."""
        gsa = backend.GrandSlamClient(FakeAnisette())
        gsa._bag = {"trustedDeviceSecondaryAuth": "https://gsa.apple.com/auth/verify/trusteddevice",
                    "validateCode": "https://gsa.apple.com/grandslam/GsService2/validate"}
        requests = []

        def answer(req):
            requests.append(req)
            reply = answers.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return reply
        gsa._open = answer
        return gsa, requests

    @staticmethod
    def _refused(url, status=403):
        return backend.urllib.error.HTTPError(url, status, "Forbidden", {}, io.BytesIO(b"Could not connect to iCloud"))

    def test_a_pushed_code_is_validated_without_asking_for_another(self):
        # Apple pushes the code by itself and answers a request for another with HTTP 403
        # (isideload #27, CapMac's second live run), so only validateCode is called.
        gsa, requests = self._two_factor_client([plistlib.dumps({"ec": 0})])
        asked = []
        gsa._two_factor({"adsid": "a", "GsIdmsToken": "t"}, "trusted", lambda mode, again: asked.append(mode) or "123456")
        self.assertEqual(asked, ["trusted"])
        self.assertEqual([(r.get_method(), r.full_url) for r in requests],
                         [("GET", "https://gsa.apple.com/grandslam/GsService2/validate")])
        self.assertEqual(requests[0].get_header("Security-code"), "123456")

    def test_a_mistyped_code_can_be_typed_again(self):
        wrong = plistlib.dumps({"ec": -21669, "em": "Incorrect verification code."})
        gsa, requests = self._two_factor_client([wrong, plistlib.dumps({"ec": 0})])
        asked = []
        gsa._two_factor({"adsid": "a", "GsIdmsToken": "t"}, "trusted",
                        lambda mode, again: asked.append((mode, again)) or ("111111" if len(asked) == 1 else "222222"))
        self.assertEqual(asked, [("trusted", False), ("trusted", True)])
        self.assertEqual([r.get_header("Security-code") for r in requests], ["111111", "222222"])
        gsa, _ = self._two_factor_client([wrong, wrong, wrong])
        with self.assertRaises(backend.GsaError) as caught:
            gsa._two_factor({"adsid": "a", "GsIdmsToken": "t"}, "trusted", lambda *_: "000000")
        self.assertEqual(caught.exception.code, -21669)

    def test_a_refused_text_says_the_account_must_be_on_the_iphone(self):
        # xtool #345 / iloader #995: Apple answers the SMS request with HTTP 403 ("Could not connect
        # to iCloud"). It texts only accounts no Apple device has, so no code can come: CapMac's
        # fifth live run asked for one anyway and waited for nothing.
        sms = "https://gsa.apple.com/auth/verify/phone/put?mode=sms"
        gsa, requests = self._two_factor_client([self._refused(sms)])
        asked = []
        with self.assertRaises(backend.GsaError) as caught:
            gsa._two_factor({"adsid": "a", "GsIdmsToken": "t"}, "sms", lambda mode, again: asked.append(mode) or "654321")
        self.assertEqual(caught.exception.code, backend.NOT_ON_IPHONE)
        self.assertIn("signed in on your iPhone", str(caught.exception))
        self.assertEqual(asked, [])
        self.assertEqual([(r.get_method(), r.full_url) for r in requests], [("POST", sms)])

    def test_sign_in_goes_out_as_android_everywhere(self):
        # Looking up as a Mac (isideload 0.4.5) put sign-in on gsa.apple.com, which answered HTTP 503
        # (iloader #927, CapMac's third live run); Apple's Android list keeps it on gsd.apple.com.
        gsa = backend.GrandSlamClient(FakeAnisette())
        requests = []
        bag = plistlib.dumps({"urls": {"gsService": "https://gsd.apple.com/grandslam/GsService2"}})
        gsa._open = lambda req: requests.append(req) or (bag if req.full_url.endswith("/lookup") else
                                                         plistlib.dumps({"Response": {"Status": {"ec": 0}}}))
        gsa._operation({"o": "init"})
        lookup, operation = requests
        self.assertEqual(lookup.get_header("X-mme-client-info"), backend.AUTH_CLIENT_INFO)
        self.assertIn("<Pixel", backend.AUTH_CLIENT_INFO)
        self.assertEqual(operation.full_url, "https://gsd.apple.com/grandslam/GsService2")
        self.assertEqual(operation.get_header("X-mme-client-info"), backend.AUTH_CLIENT_INFO)
        self.assertEqual(operation.get_header("User-agent"), "akd/1.0 CFNetwork/808.1.4")
        cpd = plistlib.loads(operation.data)["Request"]["cpd"]
        self.assertFalse({"X-Apple-I-ROM", "X-Apple-I-MLB", "X-Apple-I-SRL-NO"} & set(cpd))

    def test_an_http_error_from_the_sign_in_service_is_a_clear_error(self):
        gsa = backend.GrandSlamClient(FakeAnisette())
        gsa._bag = {"gsService": "https://gsd.apple.com/grandslam/GsService2"}
        def unavailable(req):
            raise self._refused(req.full_url, 503)
        gsa._open = unavailable
        with self.assertRaisesRegex(backend.GsaError, "HTTP 503") as caught:
            gsa._operation({"o": "init"})
        self.assertEqual(caught.exception.code, 503)

    def test_a_token_refused_with_22411_gets_the_code_then_signs_in_again(self):
        # isideload #27: Apple pushed a code without saying so in the sign-in reply, and the token
        # request failed with -22411 until that code was entered and the sign-in repeated.
        gsa = backend.GrandSlamClient(FakeAnisette())
        calls = []
        logins = iter([{"adsid": "first"}, {"adsid": "second"}])
        gsa.authenticate = lambda *_: calls.append("sign in") or next(logins)
        def token(login):
            calls.append(f"token for {login['adsid']}")
            if login["adsid"] == "first":
                raise backend.GsaError("Unable to sign in.", -22411)
            return {"token": "xcode"}
        gsa.xcode_token = token
        gsa._two_factor = lambda login, route, get_code: calls.append(f"code for {login['adsid']} ({route})")
        self.assertEqual(gsa.sign_in("audit@example.invalid", "pw", lambda *_: "000000"), {"token": "xcode"})
        self.assertEqual(calls, ["sign in", "token for first", "code for first (trusted)", "sign in", "token for second"])

    def test_xcode_token_reads_a_headerless_app_token(self):
        sk, iv = bytes(range(32)), bytes(range(16))
        payload = headerless({"t": {backend.XCODE_APP_INFO: {"token": "audit-token", "expiry": 1700000000000}}})
        gsa = backend.GrandSlamClient(FakeAnisette())
        sent = []
        gsa._operation = lambda params: sent.append(params) or {"et": b"XYZ" + iv + AESGCM(sk).encrypt(iv, payload, b"XYZ")}
        token = gsa.xcode_token({"adsid": "000000-00-audit", "GsIdmsToken": "idms", "sk": sk, "c": b"cookie"})
        self.assertEqual(token, {"adsid": "000000-00-audit", "token": "audit-token", "expiry": 1700000000000})
        self.assertEqual(sent[0]["checksum"], hmac.new(
            sk, b"apptokens" + b"000000-00-audit" + backend.XCODE_APP_INFO.encode(), hashlib.sha256).digest())

    def test_app_token_gcm_authenticates_payload(self):
        key, iv, aad = bytes(range(32)), bytes(range(16)), b"XYZ"
        payload = plistlib.dumps({"t": {"test": "token"}})
        encrypted = aad + iv + AESGCM(key).encrypt(iv, payload, aad)
        self.assertEqual(backend.decrypt_app_token(encrypted, key), payload)
        with self.assertRaises(Exception):
            backend.decrypt_app_token(encrypted[:-1] + bytes([encrypted[-1] ^ 1]), key)

    def test_new_certificate_pkcs12_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            result = backend._make_certificate(CertificateService(), folder, [])
            key, cert, _ = pkcs12.load_key_and_certificates(base64.b64decode(result["p12"]), result["password"].encode())
            self.assertEqual(key.public_key().public_numbers(), cert.public_key().public_numbers())

    def test_cached_certificate_pkcs12_roundtrip(self):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cert = make_cert(key)
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "free-development.key").write_bytes(key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
            Path(folder, "free-development.json").write_text(json.dumps({"id": "SAVED", "serial": "04D2",
                "notAfter": cert.not_valid_after_utc.isoformat(),
                "cert": base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode()}))
            ds = CertificateService([{"id": "SAVED", "attributes": {"serialNumber": "04D2"}}])
            result = backend._make_certificate(ds, folder, [])
            self.assertEqual(result["id"], "SAVED")
            pkcs12.load_key_and_certificates(base64.b64decode(result["p12"]), result["password"].encode())
            self.assertEqual(ds.calls, [("GET", "/v1/certificates")])

    def test_first_use_does_not_revoke_unrelated_team_certificates(self):
        ds = CertificateService([
            {"id": "OTHER_PC_VALID_DEV", "attributes": {"certificateType": "DEVELOPMENT", "serialNumber": "AA"}},
            {"id": "PAID_DISTRIBUTION", "attributes": {"certificateType": "DISTRIBUTION", "serialNumber": "BB"}},
        ])
        with tempfile.TemporaryDirectory() as folder:
            try:
                backend._make_certificate(ds, folder, [])
            except AttributeError:
                pass  # Packaging defect has its own two tests; inspect earlier destructive requests.
        self.assertEqual([call for call in ds.calls if call[0] == "DELETE"], [],
                         "First setup must preserve certificates belonging to other PCs and paid distribution")

    def _compressed_response(self, encoding, content):
        ds = backend.DeveloperServices(FakeAnisette(), {"adsid": "fake", "token": "fake", "teamId": "TEAM123456"})
        with patch.object(backend.urllib.request, "urlopen", return_value=Response(content, {"Content-Encoding": encoding})):
            self.assertEqual(ds.api("GET", "/v1/certificates"), {"data": []})

    def test_gzip_response_is_decoded(self):
        self._compressed_response("gzip", gzip.compress(b'{"data": []}'))

    def test_deflate_response_is_decoded(self):
        self._compressed_response("deflate", zlib.compress(b'{"data": []}'))

    def _classic_teams(self, response):
        ds = backend.DeveloperServices(FakeAnisette(), {"adsid": "fake", "token": "fake", "teamId": ""})
        with patch.object(backend.urllib.request, "urlopen", return_value=response):
            return ds.teams()

    def test_classic_reads_compressed_and_json_team_lists(self):
        # CapMac's sixth live run: sign-in worked, then listTeams' reply wasn't a plist on its face.
        teams = {"resultCode": 0, "teams": [{"teamId": "FREE123456", "name": "Audit Person", "memberships": []}]}
        expected = [{"id": "FREE123456", "name": "Audit Person", "status": None, "free": True}]
        self.assertEqual(self._classic_teams(Response(gzip.compress(plistlib.dumps(teams)), {"Content-Encoding": "gzip"})), expected)
        self.assertEqual(self._classic_teams(Response(gzip.compress(plistlib.dumps(teams)))), expected)  # no header
        self.assertEqual(self._classic_teams(Response(json.dumps(teams).encode(), {"Content-Type": "application/json"})), expected)

    def test_an_unreadable_classic_reply_is_a_clear_error_with_its_shape_logged(self):
        for body in (b"", b"\x00\x01binary", b"<html><body>Service Unavailable</body></html>"):
            with self.subTest(body=body[:8]), patch.object(backend, "log") as logged:
                with self.assertRaises(backend.DsError) as caught:
                    self._classic_teams(Response(body, {"Content-Type": "text/html"}))
                self.assertIn("couldn't read", str(caught.exception))
                self.assertIn(f"{len(body)} bytes", logged.call_args[0][0])
                self.assertIn("text/html", logged.call_args[0][0])

    def test_sms_uses_phone_post_endpoints_and_plist_bodies(self):
        # Reference: xtool GrandSlamSMSAuthRequest + GrandSlamValidateSMSRequest.
        gsa = backend.GrandSlamClient(FakeAnisette())
        gsa._bag = {"secondaryAuth": "https://gsa.apple.com/secondaryAuth", "validateCode": "https://gsa.apple.com/validateCode"}
        requests = []
        gsa._open = lambda req: requests.append(req) or b""
        gsa._two_factor({"adsid": "fake", "GsIdmsToken": "fake"}, "sms", lambda mode, again: "123456")
        self.assertEqual([(r.get_method(), r.full_url) for r in requests], [
            ("POST", "https://gsa.apple.com/auth/verify/phone/put?mode=sms"),
            ("POST", "https://gsa.apple.com/auth/verify/phone/securitycode?referrer=/auth/verify/phone/put"),
        ])
        self.assertEqual(plistlib.loads(requests[1].data), {"securityCode.code": "123456",
                         "serverInfo": {"mode": "sms", "phoneNumber.id": "1"}})

    XCODE = "/Developer_Tools/Xcode_26.6/Xcode_26.6_Apple_silicon.xip"

    @staticmethod
    def _headers(*pairs):
        message = email.message.Message()
        for name, value in pairs:
            message[name] = value  # appends: Set-Cookie may come more than once
        return message

    def _grant(self, answer, path=XCODE):
        """download_grant against a stand-in opener that answers `answer` (a Response, or an HTTPError)."""
        ds = backend.DeveloperServices(FakeAnisette(), {"adsid": "fake", "token": "fake-gs-token", "teamId": ""})
        opened = []

        class Opener:
            def open(self, req, timeout=None):
                opened.append(req)
                if isinstance(answer, Exception):
                    raise answer
                return answer
        with patch.object(backend.urllib.request, "build_opener", return_value=Opener()):
            return ds.download_grant(path), opened

    def test_download_grant_asks_developer_services_the_way_xcode_does(self):
        # The free sign-in can't read Apple's download list (the website's), so CapMac asks for the
        # managed Xcode's archive by name, with the Xcode token, and keeps only Apple's grant cookie.
        answer = Response(b"", self._headers(("Set-Cookie", "dslang=US-EN; Domain=apple.com; Path=/"),
                                             ("Set-Cookie", "ADCDownloadAuth=grant-ok; Domain=apple.com; Path=/; Secure")))
        grant, opened = self._grant(answer)
        self.assertEqual(grant, {"cookies": ["ADCDownloadAuth=grant-ok"], "location": None})
        self.assertEqual(opened[0].full_url, "https://developerservices2.apple.com/services/download?path=" + self.XCODE)
        self.assertEqual(opened[0].get_header("X-apple-gs-token"), "fake-gs-token")
        self.assertEqual(opened[0].get_header("X-apple-app-info"), "com.apple.gs.xcode.auth")

    def test_download_grant_takes_the_cookie_from_a_redirect(self):
        file = "https://download.developer.apple.com" + self.XCODE
        found = backend.urllib.error.HTTPError("https://developerservices2.apple.com/services/download", 302, "Found",
                                               self._headers(("Set-Cookie", "ADCDownloadAuth=grant-302; Domain=apple.com"),
                                                             ("Location", file)), io.BytesIO(b""))
        grant, _ = self._grant(found)
        self.assertEqual(grant, {"cookies": ["ADCDownloadAuth=grant-302"], "location": file})

    def test_a_refused_download_grant_is_a_clear_error(self):
        refused = backend.urllib.error.HTTPError("https://developerservices2.apple.com/services/download", 403, "Forbidden",
                                                 self._headers(), io.BytesIO(b"<html>Forbidden</html>"))
        with patch.object(backend, "log"), self.assertRaises(backend.DsError) as caught:
            self._grant(refused)
        self.assertEqual(caught.exception.code, 403)
        self.assertIn("did not allow the Xcode download", str(caught.exception))
        with patch.object(backend, "log"), self.assertRaises(backend.DsError):
            self._grant(Response(b"", self._headers(("Content-Type", "text/plain"))))  # no grant cookie at all

    def test_download_grant_asks_only_for_xcode_archives(self):
        ds = backend.DeveloperServices(FakeAnisette(), {"adsid": "fake", "token": "fake", "teamId": ""})
        for path in ("/etc/passwd", "/Developer_Tools/../secret.xip", "/Developer_Tools/Xcode.xip?x=1", "/Other/Xcode.xip"):
            with self.subTest(path=path), patch.object(backend.urllib.request, "build_opener") as opener:
                with self.assertRaises(backend.DsError):
                    ds.download_grant(path)
                opener.assert_not_called()

    def test_an_app_id_another_team_has_says_to_pick_your_own(self):
        # The sample app's dev.capmac.hello belongs to the user's paid team, so their free team can't have it.
        class BundleService:
            def api(self, method, path, **kwargs):
                if method == "POST":
                    raise backend.DsError("An App ID with Identifier 'dev.capmac.hello' is not available. "
                                          "Please enter a different string.", 409)
                return {"data": []}
        with self.assertRaises(backend.DsError) as caught:
            backend._ensure_bundle_id(BundleService(), "dev.capmac.hello", [])
        self.assertIn("Another Apple team already has the app ID dev.capmac.hello", str(caught.exception))
        self.assertEqual(caught.exception.code, 409)

    def test_current_device_registration_failure_is_fatal(self):
        class DeviceService:
            def api(self, method, path, **kwargs):
                if method == "POST":
                    raise backend.DsError("device quota reached", 403)
                return {"data": [{"id": "OTHER_IPHONE", "attributes": {
                    "udid": "OTHER", "status": "ENABLED", "deviceClass": "IPHONE"}}]}
        with self.assertRaises(backend.DsError):
            backend._ensure_device(DeviceService(), {"udid": "CURRENT_IPHONE", "name": "Current Phone"}, [])

    def test_failed_library_download_does_not_leave_reusable_cache(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in backend.WANTED_LIBS:
                zf.writestr(name, b"synthetic library: " + name.encode())
        contents = archive.getvalue()
        with zipfile.ZipFile(io.BytesIO(contents)) as zf:
            second = zf.getinfo(backend.WANTED_LIBS[1])
            second_header = second.header_offset
        def get(req, **kwargs):
            if req.get_method() == "HEAD":
                return Response(b"", {"Content-Length": str(len(contents))})
            start, end = map(int, req.get_header("Range").removeprefix("bytes=").split("-"))
            if start == second_header:
                raise OSError("synthetic network interruption")
            return Response(contents[start:end + 1], status=206)
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder, "adi-libs.zip")
            with patch.object(backend.urllib.request, "urlopen", side_effect=get):
                with self.assertRaises(OSError):
                    backend.fetch_adi_libraries(str(target))
            self.assertFalse(target.exists(), "An interrupted fetch must not poison the cache used by later logins")


try:
    from anisette import Anisette as RealAnisette
except ImportError:
    RealAnisette = None


@unittest.skipIf(RealAnisette is None, "Install anisette or set CAPMAC_AUDIT_ANISETTE_PATH for package compatibility probes")
class InstalledAnisetteCompatibility(unittest.TestCase):
    def test_init_save_load_accepts_generated_library_archive(self):
        # No emulator or provisioning executes; libraries contain sentinels to test archive/API compatibility.
        with tempfile.TemporaryDirectory() as folder:
            libs, state = Path(folder, "libs.zip"), Path(folder, "state.bin")
            with zipfile.ZipFile(libs, "w") as zf:
                for name in backend.WANTED_LIBS:
                    zf.writestr(name, b"audit sentinel")
            ani = RealAnisette.init(str(libs))
            self.assertIsNotNone(ani._ani_provider.library_store)
            self.assertIsNotNone(ani._ani_provider.device)
            ani.save_all(str(state))
            reloaded = RealAnisette.load(str(state))
            with reloaded._ani_provider.library_store.open_library("libCoreADI.so") as f:
                self.assertEqual(f.read(), b"audit sentinel")

    def test_get_data_compatible_with_backend_header_filter(self):
        provider = types.SimpleNamespace(
            adi=types.SimpleNamespace(is_machine_provisioned=lambda _: True,
                request_otp=lambda _: types.SimpleNamespace(otp=b"otp", machine_id=b"machine")),
            device=types.SimpleNamespace(local_user_uuid="local", server_friendly_description="client",
                unique_device_identifier="device"))
        wrapper = backend.Anisette.__new__(backend.Anisette)
        wrapper._ani = RealAnisette(provider)
        headers = wrapper.headers()
        self.assertEqual(headers["X-Apple-I-MD"], base64.b64encode(b"otp").decode())
        self.assertEqual(headers["X-Mme-Device-Id"], "device")
        # anisette.py sends local time + "Z" and Windows names; Apple gets xtool's forms instead.
        self.assertRegex(headers["X-Apple-I-Client-Time"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual((headers["X-Apple-I-TimeZone"], headers["X-Apple-Locale"]), ("UTC", "en_US"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
