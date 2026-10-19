# CapMac free Apple Account backend: sign in to Apple Developer Services the way
# Xcode does (GrandSlam/GSA + a locally emulated anisette machine), so a free
# Apple ID with no paid membership can make a development certificate and 7-day
# provisioning profiles for the developer's own app on their own device. It runs
# in CapMac's own Python on Windows and talks to the TypeScript engine over
# stdin/stdout as newline-delimited JSON (stderr is for human-readable logs only).
#
# The sign-in crypto and request headers mirror xtool (xtool-org/xtool, MIT) so
# CapMac keeps in step with a client Apple currently accepts (the 2026-10
# GrandSlam change rejected the old macOS device string; we present as a Pixel 7,
# matching xtool main). Credentials are only ever sent to Apple.
#
# Protocol (one JSON object per line):
#   <- {"id":N,"op":"login","username":..,"password":..}
#   -> {"event":"need-code","mode":"trusted|sms","again":false}   (then wait for a code line)
#      trusted: a code on the Apple devices (pushed by Apple, or made under Settings); sms: Apple
#      texted one; again: the last code was wrong
#   <- {"op":"code","code":"123456"}
#   -> {"id":N,"ok":true,"result":{"teams":[{"id","name","free"}]}}
#   <- {"id":N,"op":"provision","teamId":..,"targets":[{"bundleIdentifier","capabilities":[..]}],
#                               "device":{"udid","name"},"dir":..}
#   -> {"id":N,"ok":true,"result":{"certificate":{"serial","notAfter"},
#                                   "p12":"<base64>","password":..,
#                                   "profiles":{"<bundleId>":"<base64 mobileprovision>"},"notes":[..]}}
#   <- {"op":"shutdown"}
# Xcode itself is downloaded through Apple's website (apple-web.ts): developerservices2 turns the
# Xcode sign-in's download request away (HTTP 403, checked live 2026-10-19).
# Every reply to an op carrying an id is {ok:true,result} or {ok:false,error,code?,hint?}.
from __future__ import annotations

import base64
import datetime
import gzip
import hashlib
import hmac
import json
import os
import plistlib
import secrets
import ssl
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
import zlib
from typing import Any, Callable

# --- client identity, matching xtool and isideload (the strings Apple accepts post 2026-10) ---
# GrandSlam auth presents as an Android device, since our anisette comes from Android's ADI;
# anisette's own machine provisioning keeps its (macOS) description.
AUTH_CLIENT_INFO = "<Pixel 7> <Android;14;UQ1A.240205.002> <com.apple.AuthKit/1 (com.apple.akd/1.0)>"
AUTH_USER_AGENT = "akd/1.0 CFNetwork/808.1.4"
# The endpoint lookup goes out as Android too, which gets Apple's short list on gsd.apple.com.
# Looking up as a Mac (isideload 0.4.5) moves sign-in to gsa.apple.com, which since 2026-10-15
# answers Android sign-ins with HTTP 503 (iloader #927, and CapMac's own third live run).
XCODE_VERSION = "26.5 (17F42)"
XCODE_APP_INFO = "com.apple.gs.xcode.auth"
# CapMac's own error code, not Apple's: Apple wanted to text a code and wouldn't. It texts only
# accounts no Apple device has, so the account must be signed in on the iPhone (free-apple.ts).
NOT_ON_IPHONE = -90001

APPLE_MUSIC_APK = "https://apps.mzstatic.com/content/android-apple-music-apk/applemusic.apk"
WANTED_LIBS = ("lib/arm64-v8a/libCoreADI.so", "lib/arm64-v8a/libstoreservicescore.so")
DS2 = "https://developerservices2.apple.com/services"
SERVICE_PROTOCOL_VERSION = "QH65B2"
SERVICE_CLIENT_ID = "XABBG36SBA"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


# Apple's encrypted sign-in replies hold a bare "<dict>…</dict>" with no "<?xml …?>" line. Apple's own
# parser takes that, but plistlib only recognises XML that starts with one (pypush adds it back too).
_PLIST_XML_HEADER = (b'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
                     b'"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n')


def load_plist(data: bytes) -> Any:
    """plistlib.loads that also reads the header-less XML inside Apple's encrypted replies."""
    try:
        return plistlib.loads(data)
    except plistlib.InvalidFileException:
        body = data.lstrip()
        if body.startswith(b"<?xml"):
            return plistlib.loads(body)
        if not body.startswith(b"<"):
            raise
        return plistlib.loads(_PLIST_XML_HEADER + body)


def describe_reply(data: bytes) -> str:
    """The size and first bytes of a decrypted reply, for the log: too few to hold any of its secrets."""
    head = data[:8]
    shown = head.decode("ascii") if all(32 <= b < 127 or b in b"\t\r\n" for b in head) else head.hex()
    return f"{len(data)} bytes starting {shown!r}"


def read_body(response: Any) -> bytes:
    """A reply's bytes, unpacked when the server compressed them. urllib leaves gzip and deflate to
    the caller, so a compressed reply would otherwise reach the parser as is."""
    data = response.read()
    headers = getattr(response, "headers", None)
    encoding = str(headers.get("Content-Encoding") or "").lower() if headers is not None else ""
    if "gzip" in encoding or data[:2] == b"\x1f\x8b":
        return gzip.decompress(data)
    if "deflate" in encoding:
        try:
            return zlib.decompress(data)
        except zlib.error:
            return zlib.decompress(data, -15)  # raw deflate, which some servers send under that name
    return data


# --- TLS: this PC's trust plus Apple's own roots ------------------------------------------------
# Apple's sign-in hosts use Apple's private certificate authority: gsa.apple.com chains to Apple
# Root CA, and gsd.apple.com (where GrandSlam sends Android clients like ours) to Apple Root CA -
# G3. certifi has no Apple roots and neither does Microsoft's root list, so Windows never trusts
# these hosts on its own. Like xtool and anisette, we carry Apple's public roots
# (apple.com/certificateauthority).
APPLE_ROOT_CERTIFICATES = """\
# Apple Root CA (SHA-256 b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024)
-----BEGIN CERTIFICATE-----
MIIEuzCCA6OgAwIBAgIBAjANBgkqhkiG9w0BAQUFADBiMQswCQYDVQQGEwJVUzET
MBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwHhcNMDYwNDI1MjE0
MDM2WhcNMzUwMjA5MjE0MDM2WjBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBw
bGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkx
FjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAw
ggEKAoIBAQDkkakJH5HbHkdQ6wXtXnmELes2oldMVeyLGYne+Uts9QerIjAC6Bg+
+FAJ039BqJj50cpmnCRrEdCju+QbKsMflZ56DKRHi1vUFjczy8QPTc4UadHJGXL1
XQ7Vf1+b8iUDulWPTV0N8WQ1IxVLFVkds5T39pyez1C6wVhQZ48ItCD3y6wsIG9w
tj8BMIy3Q88PnT3zK0koGsj+zrW5DtleHNbLPbU6rfQPDgCSC7EhFi501TwN22IW
q6NxkkdTVcGvL0Gz+PvjcM3mo0xFfh9Ma1CWQYnEdGILEINBhzOKgbEwWOxaBDKM
aLOPHd5lc/9nXmW8Sdh2nzMUZaF3lMktAgMBAAGjggF6MIIBdjAOBgNVHQ8BAf8E
BAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUK9BpR5R2Cf70a40uQKb3
R01/CF4wHwYDVR0jBBgwFoAUK9BpR5R2Cf70a40uQKb3R01/CF4wggERBgNVHSAE
ggEIMIIBBDCCAQAGCSqGSIb3Y2QFATCB8jAqBggrBgEFBQcCARYeaHR0cHM6Ly93
d3cuYXBwbGUuY29tL2FwcGxlY2EvMIHDBggrBgEFBQcCAjCBthqBs1JlbGlhbmNl
IG9uIHRoaXMgY2VydGlmaWNhdGUgYnkgYW55IHBhcnR5IGFzc3VtZXMgYWNjZXB0
YW5jZSBvZiB0aGUgdGhlbiBhcHBsaWNhYmxlIHN0YW5kYXJkIHRlcm1zIGFuZCBj
b25kaXRpb25zIG9mIHVzZSwgY2VydGlmaWNhdGUgcG9saWN5IGFuZCBjZXJ0aWZp
Y2F0aW9uIHByYWN0aWNlIHN0YXRlbWVudHMuMA0GCSqGSIb3DQEBBQUAA4IBAQBc
NplMLXi37Yyb3PN3m/J20ncwT8EfhYOFG5k9RzfyqZtAjizUsZAS2L70c5vu0mQP
y3lPNNiiPvl4/2vIB+x9OYOLUyDTOMSxv5pPCmv/K/xZpwUJfBdAVhEedNO3iyM7
R6PVbyTi69G3cN8PReEnyvFteO3ntRcXqNx+IjXKJdXZD9Zr1KIkIxH3oayPc4Fg
xhtbCS+SsvhESPBgOJ4V9T0mZyCKM2r3DYLP3uujL/lTaltkwGMzd/c6ByxW69oP
IQ7aunMZT7XZNn/Bh1XZp5m5MkL72NVxnn6hUrcbvZNCJBIqxw8dtk2cXmPIS4AX
UKqK1drk/NAJBzewdXUh
-----END CERTIFICATE-----
# Apple Root CA - G2 (SHA-256 c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050)
-----BEGIN CERTIFICATE-----
MIIFkjCCA3qgAwIBAgIIAeDltYNno+AwDQYJKoZIhvcNAQEMBQAwZzEbMBkGA1UE
AwwSQXBwbGUgUm9vdCBDQSAtIEcyMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0
aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMw
HhcNMTQwNDMwMTgxMDA5WhcNMzkwNDMwMTgxMDA5WjBnMRswGQYDVQQDDBJBcHBs
ZSBSb290IENBIC0gRzIxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0
aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzCCAiIwDQYJ
KoZIhvcNAQEBBQADggIPADCCAgoCggIBANgREkhI2imKScUcx+xuM23+TfvgHN6s
XuI2pyT5f1BrTM65MFQn5bPW7SXmMLYFN14UIhHF6Kob0vuy0gmVOKTvKkmMXT5x
ZgM4+xb1hYjkWpIMBDLyyED7Ul+f9sDx47pFoFDVEovy3d6RhiPw9bZyLgHaC/Yu
OQhfGaFjQQscp5TBhsRTL3b2CtcM0YM/GlMZ81fVJ3/8E7j4ko380yhDPLVoACVd
J2LT3VXdRCCQgzWTxb+4Gftr49wIQuavbfqeQMpOhYV4SbHXw8EwOTKrfl+q04tv
ny0aIWhwZ7Oj8ZhBbZF8+NfbqOdfIRqMM78xdLe40fTgIvS/cjTf94FNcX1RoeKz
8NMoFnNvzcytN31O661A4T+B/fc9Cj6i8b0xlilZ3MIZgIxbdMYs0xBTJh0UT8TU
gWY8h2czJxQI6bR3hDRSj4n4aJgXv8O7qhOTH11UL6jHfPsNFL4VPSQ08prcdUFm
IrQB1guvkJ4M6mL4m1k8COKWNORj3rw31OsMiANDC1CvoDTdUE0V+1ok2Az6DGOe
HwOx4e7hqkP0ZmUoNwIx7wHHHtHMn23KVDpA287PT0aLSmWaasZobNfMmRtHsHLD
d4/E92GcdB/O/WuhwpyUgquUoue9G7q5cDmVF8Up8zlYNPXEpMZ7YLlmQ1A/bmH8
DvmGqmAMQ0uVAgMBAAGjQjBAMB0GA1UdDgQWBBTEmRNsGAPCe8CjoA1/coB6HHcm
jTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQwF
AAOCAgEAUabz4vS4PZO/Lc4Pu1vhVRROTtHlznldgX/+tvCHM/jvlOV+3Gp5pxy+
8JS3ptEwnMgNCnWefZKVfhidfsJxaXwU6s+DDuQUQp50DhDNqxq6EWGBeNjxtUVA
eKuowM77fWM3aPbn+6/Gw0vsHzYmE1SGlHKy6gLti23kDKaQwFd1z4xCfVzmMX3z
ybKSaUYOiPjjLUKyOKimGY3xn83uamW8GrAlvacp/fQ+onVJv57byfenHmOZ4VxG
/5IFjPoeIPmGlFYl5bRXOJ3riGQUIUkhOb9iZqmxospvPyFgxYnURTbImHy99v6Z
SYA7LNKmp4gDBDEZt7Y6YUX6yfIjyGNzv1aJMbDZfGKnexWoiIqrOEDCzBL/FePw
N983csvMmOa/orz6JopxVtfnJBtIRD6e/J/JzBrsQzwBvDR4yGn1xuZW7AYJNpDr
FEobXsmII9oDMJELuDY++ee1KG++P+w8j2Ud5cAeh6Squpj9kuNsJnfdBrRkBof0
Tta6SqoWqPQFZ2aWuuJVecMsXUmPgEkrihLHdoBR37q9ZV0+N0djMenl9MU/S60E
inpxLK8JQzcPqOMyT/RFtm2XNuyE9QoB6he7hY1Ck3DDUOUUi78/w0EP3SIEIwiK
um1xRKtzCTrJ+VKACd+66eYWyi4uTLLT3OUEVLLUNIAytbwPF+E=
-----END CERTIFICATE-----
# Apple Root CA - G3 (SHA-256 63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179)
-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----
"""


def use_windows_trust() -> bool:
    """Check HTTPS certificates with Windows' own verifier (truststore) instead of OpenSSL's.

    CapMac then trusts what this PC trusts, such as a company proxy or antivirus that inspects
    HTTPS, and gets Windows' revocation checks. Call once, before any connection. Returns False
    when truststore is missing or this isn't Windows; tls_context() then falls back to certifi.
    """
    if sys.platform != "win32":
        return False
    try:
        import truststore
        truststore.inject_into_ssl()
        return True
    except Exception:  # noqa: BLE001 - not installed yet, or this Python can't load it
        return False


def tls_context() -> ssl.SSLContext:
    """The TLS context for every Apple request: this PC's trust plus Apple's own roots.

    After use_windows_trust() Windows checks each certificate first, and the Apple roots cover
    the hosts it rejects. Without truststore, OpenSSL uses the Windows store, certifi and the
    Apple roots.
    """
    ctx = ssl.create_default_context()
    if not type(ctx).__module__.startswith("truststore"):
        try:
            import certifi  # installed with anisette
            ctx.load_verify_locations(cafile=certifi.where())
        except Exception:  # noqa: BLE001 - the Windows store and the Apple roots still apply
            pass
    ctx.load_verify_locations(cadata=APPLE_ROOT_CERTIFICATES)
    return ctx


# --- Apple's sign-in libraries, fetched straight from Apple (a few MB, not the 140 MB APK) ----

def fetch_adi_libraries(dest_zip: str) -> None:
    """Range-fetch only libCoreADI.so + libstoreservicescore.so from Apple's Apple Music APK.

    Anisette.py would otherwise download a prebuilt bundle from a third-party Cloudflare
    worker; CapMac takes the libraries from Apple directly instead.
    """
    context = tls_context()

    def get_range(start: int, end: int) -> bytes:
        req = urllib.request.Request(APPLE_MUSIC_APK, headers={"Range": f"bytes={start}-{end}"})
        with urllib.request.urlopen(req, timeout=120, context=context) as r:
            if r.status != 206:
                raise RuntimeError(f"Apple answered HTTP {r.status} to a ranged download")
            return r.read()

    with urllib.request.urlopen(urllib.request.Request(APPLE_MUSIC_APK, method="HEAD"), timeout=60, context=context) as r:
        size = int(r.headers["Content-Length"])
    tail = get_range(max(0, size - 65536 - 22), size - 1)
    eocd = tail.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise RuntimeError("could not read the APK's central directory")
    cd_size, cd_offset = struct.unpack("<II", tail[eocd + 12:eocd + 20])
    cd = get_range(cd_offset, cd_offset + cd_size - 1)
    entries: dict[str, tuple[int, int, int, int, int]] = {}
    p = 0
    while p + 46 <= len(cd):
        f = struct.unpack("<IHHHHHHIIIHHHHHII", cd[p:p + 46])
        if f[0] != 0x02014B50:
            break
        method, crc, csize, usize, nlen, elen, clen, lho = f[4], f[7], f[8], f[9], f[10], f[11], f[12], f[16]
        name = cd[p + 46:p + 46 + nlen].decode("utf-8", "replace")
        entries[name] = (method, crc, csize, usize, lho)
        p += 46 + nlen + elen + clen
    # Build into a temporary file and rename only once both libraries are present and verified,
    # so an interrupted download never leaves a half-written cache that future runs would trust.
    partial = dest_zip + ".part"
    with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in WANTED_LIBS:
            if name not in entries:
                raise RuntimeError(f"Apple's APK no longer contains {name}")
            method, crc, csize, usize, lho = entries[name]
            lh = get_range(lho, lho + 29)
            nlen, elen = struct.unpack("<HH", lh[26:30])
            start = lho + 30 + nlen + elen
            comp = get_range(start, start + csize - 1)
            data = comp if method == 0 else zlib.decompress(comp, -15)
            if (zlib.crc32(data) & 0xFFFFFFFF) != crc or len(data) != usize:
                raise RuntimeError(f"{name} failed its checksum")
            zf.writestr(name, data)
    os.replace(partial, dest_zip)


class Anisette:
    """Thin wrapper over the `anisette` package that keeps a provisioned machine on disk."""

    def __init__(self, state_dir: str) -> None:
        from anisette import Anisette as _Anisette  # late import: installed lazily at setup

        self._dir = state_dir
        os.makedirs(state_dir, exist_ok=True)
        libs = os.path.join(state_dir, "adi-libs.zip")
        if not os.path.exists(libs):
            log("Fetching Apple's sign-in libraries…")
            fetch_adi_libraries(libs)
        state = os.path.join(state_dir, "anisette.bin")
        self._state = state
        self._ani = _Anisette.load(state) if os.path.exists(state) else _Anisette.init(libs)
        self._ani.provision()
        self._ani.save_all(state)

    def headers(self) -> dict[str, str]:
        """The anisette header set xtool's AnisetteData sends (no client-info; we set that ourselves).

        anisette.py fills the time, time zone and locale from this PC's settings, which on Windows
        come out as "2026-10-19T13:53:15+02:00Z", "W. Europe Daylight Time" and
        "English_United States". We send them the way xtool does: UTC time, "UTC", "en_US".
        """
        data = self._ani.get_data()
        keep = ("X-Apple-I-MD", "X-Apple-I-MD-M", "X-Apple-I-MD-LU", "X-Apple-I-MD-RINFO", "X-Mme-Device-Id")
        headers = {k: data[k] for k in keep if k in data}
        headers["X-Apple-I-Client-Time"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        headers["X-Apple-I-TimeZone"] = "UTC"
        headers["X-Apple-Locale"] = "en_US"
        return headers


# --- SRP-6a sign-in, ported from xtool's SRPClient (CryptoKit) ---------------------------------
# 2048-bit group, SHA-256. The transcript hash (used to verify Apple's response) must be fed the
# same byte sequence xtool feeds CryptoKit, so the order of add_string/add_data below is exact.
_N = int(
    "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13"
    "DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93"
    "B855F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6"
    "481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E5"
    "7AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB694B5C803D89F7AE435DE236D525"
    "F54759B65E372FCD68EF20FA7111F9E4AFF73", 16)
_g = 2
_N_BYTES = (_N.bit_length() + 7) // 8  # 256


def _to_bytes(value: int) -> bytes:
    return value.to_bytes((value.bit_length() + 7) // 8 or 1, "big")


def _pad(data: bytes, length: int) -> bytes:
    return b"\x00" * (length - len(data)) + data if len(data) < length else data


def _sha(*chunks: bytes) -> bytes:
    d = hashlib.sha256()
    for c in chunks:
        d.update(c)
    return d.digest()


class SRPClient:
    def __init__(self) -> None:
        self._a = int.from_bytes(secrets.token_bytes(32), "big")
        self._A = pow(_g, self._a, _N)
        self._digest = hashlib.sha256()
        self._K: bytes | None = None
        self._hamk: bytes | None = None

    def add_string(self, text: str) -> None:
        self._digest.update(text.encode("utf-8"))

    def add_data(self, data: bytes) -> None:
        self._digest.update(struct.pack("<I", len(data)))
        self._digest.update(data)

    def public_key(self) -> bytes:
        return _to_bytes(self._A)

    def process_challenge(self, username: str, password: str, salt: bytes, iterations: int,
                          legacy: bool, raw_b: bytes) -> bytes:
        big_b = int.from_bytes(raw_b, "big")
        if big_b % _N == 0:
            raise ValueError("Apple returned an invalid SRP value")
        hashed = hashlib.sha256(password.encode("utf-8")).digest()
        pbkdf_input = hashed.hex().encode("ascii") if legacy else hashed
        passkey = hashlib.pbkdf2_hmac("sha256", pbkdf_input, salt, iterations, 32)
        x = int.from_bytes(_sha(salt, _sha(b":", passkey)), "big")
        u = int.from_bytes(_sha(_pad(_to_bytes(self._A), _N_BYTES), _pad(raw_b, _N_BYTES)), "big")
        k = int.from_bytes(_sha(_pad(_to_bytes(_N), _N_BYTES), _pad(_to_bytes(_g), _N_BYTES)), "big")
        raw_k = pow((big_b - (pow(_g, x, _N) * k) % _N) % _N, self._a + u * x, _N)
        self._K = _sha(_to_bytes(raw_k))
        a_data = _to_bytes(self._A)
        xor_hash = bytes(a ^ b for a, b in zip(_sha(_pad(_to_bytes(_g), _N_BYTES)), _sha(_to_bytes(_N))))
        m = _sha(xor_hash, _sha(username.encode("utf-8")), salt, a_data, raw_b, self._K)
        self._hamk = _sha(a_data, m, self._K)
        return m

    def _session_key(self, name: str) -> bytes:
        if self._K is None:
            raise ValueError("SRP challenge has not been processed")
        return hmac.new(self._K, name.encode("utf-8"), hashlib.sha256).digest()

    def verify_hamk(self, hamk: bytes) -> bool:
        return self._hamk is not None and hmac.compare_digest(hamk, self._hamk)

    def verify_neg_proto(self, neg_proto: bytes) -> bool:
        mac = hmac.new(self._session_key("HMAC key:"), self._digest.digest(), hashlib.sha256).digest()
        return hmac.compare_digest(neg_proto, mac)

    def decrypt(self, cbc: bytes) -> bytes:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        if not cbc or len(cbc) % 16:
            raise ValueError(f"{len(cbc)} bytes is not a whole number of AES blocks")
        key = self._session_key("extra data key:")
        iv = self._session_key("extra data iv:")[:16]
        decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        padded = decryptor.update(cbc) + decryptor.finalize()
        size = padded[-1]
        if not 1 <= size <= 16 or padded[-size:] != bytes([size]) * size:
            raise ValueError("the PKCS#7 padding is wrong, so the key or the cipher is not what Apple used")
        return padded[:-size]


def decrypt_app_token(gcm: bytes, sk: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aad, iv, payload_tag = gcm[:3], gcm[3:19], gcm[19:]
    return AESGCM(sk).decrypt(iv, payload_tag, aad)


class GsaError(Exception):
    def __init__(self, message: str, code: int = 0) -> None:
        super().__init__(message)
        self.code = code


def read_reply(plain: bytes, what: str) -> dict[str, Any]:
    """A decrypted reply as a dictionary. If it isn't one, log only its size and first bytes."""
    try:
        reply = load_plist(plain)
    except Exception as error:  # noqa: BLE001 - expat and plistlib raise several kinds
        log(f"{what}: {describe_reply(plain)} is not a property list: {error!r}")
        raise GsaError(f"Apple's {what} could not be read.") from error
    if not isinstance(reply, dict):
        log(f"{what}: {describe_reply(plain)} holds a {type(reply).__name__}, not a dictionary")
        raise GsaError(f"Apple's {what} could not be read.")
    return reply


def require(reply: dict[str, Any], what: str, *keys: str) -> dict[str, Any]:
    """The named fields of a reply. If any are missing, log the names (never the values) it has."""
    missing = [key for key in keys if key not in reply]
    if missing:
        log(f"{what} has {sorted(reply)} but not {missing}")
        raise GsaError(f"Apple's {what} is missing {', '.join(missing)}.")
    return {key: reply[key] for key in keys}


def reply_status(raw: bytes) -> tuple[int, str]:
    """The error code and message in a GrandSlam answer: (0, "") when it has none or isn't a plist."""
    try:
        reply = load_plist(raw) if raw.strip() else {}
    except Exception:  # noqa: BLE001 - some answers are web pages, not plists
        return 0, ""
    if not isinstance(reply, dict):
        return 0, ""
    status = reply["Status"] if isinstance(reply.get("Status"), dict) else reply
    try:
        return int(status.get("ec") or 0), str(status.get("em") or "")
    except (TypeError, ValueError):
        return 0, ""


def second_factor_route(reply: dict[str, Any], status: dict[str, Any]) -> str | None:
    """Whether Apple wants a verification code, and where: "trusted" (the devices), "sms", or None.

    Apple signals it with Status.au (AltSign, pypush, isideload; "repair" only means the account has
    no two-factor), Status.hsc 409 (isideload: a code was already sent), or status-code 409 and url
    inside the reply (xtool).
    """
    au = status.get("au")
    if not (au in ("trustedDeviceSecondaryAuth", "secondaryAuth") or str(status.get("hsc")) == "409"
            or str(reply.get("status-code")) == "409"):
        if au not in (None, "", "repair"):
            log(f"sign-in reply: Apple also asked for '{au}'")
        return None
    kind = au if au in ("trustedDeviceSecondaryAuth", "secondaryAuth") else reply.get("url")
    return "sms" if kind == "secondaryAuth" else "trusted"


class GrandSlamClient:
    """Signs in with GrandSlam and fetches the Xcode app token, as Xcode/xtool do."""

    def __init__(self, anisette: Anisette) -> None:
        self._ani = anisette
        self._bag: dict[str, str] = {}
        self._ssl = tls_context()

    def _open(self, req: urllib.request.Request) -> bytes:
        # GrandSlam dislikes reused (keep-alive) connections; urllib opens a fresh one each call.
        with urllib.request.urlopen(req, timeout=30, context=self._ssl) as r:
            return r.read()

    def _lookup(self) -> dict[str, str]:
        if not self._bag:
            req = urllib.request.Request("https://gsa.apple.com/grandslam/GsService2/lookup", headers={
                "X-MMe-Client-Info": AUTH_CLIENT_INFO, "Accept": "*/*", "User-Agent": AUTH_USER_AGENT})
            self._bag = load_plist(self._open(req))["urls"]
        return self._bag

    def _cpd(self) -> dict[str, Any]:
        # No made-up Mac serial numbers: xtool and isideload both stopped sending them.
        cpd: dict[str, Any] = {"bootstrap": True, "icscrec": True, "pbe": False, "prkgen": True,
                               "svct": "iCloud", "loc": "en_US"}
        cpd.update(self._ani.headers())
        return cpd

    def _operation(self, params: dict[str, Any]) -> dict[str, Any]:
        url = self._lookup()["gsService"]
        body = plistlib.dumps({"Header": {"Version": "1.0.1"}, "Request": {"cpd": self._cpd(), **params}})
        req = urllib.request.Request(url, data=body, headers={
            "Content-Type": "text/x-xml-plist", "Accept": "*/*", "User-Agent": AUTH_USER_AGENT,
            "X-MMe-Client-Info": AUTH_CLIENT_INFO}, method="POST")
        try:
            raw = self._open(req)
        except urllib.error.HTTPError as error:
            log(f"sign-in: {url} answered HTTP {error.code}: {error.read()[:300]!r}")
            raise GsaError(f"Apple's sign-in service answered HTTP {error.code}.", error.code) from error
        response = load_plist(raw)["Response"]
        status = response.get("Status", {})
        if status.get("ec", 0) != 0:
            raise GsaError(status.get("em") or "Apple sign-in failed", int(status.get("ec", 0)))
        return response

    def _two_factor(self, login: dict[str, Any], route: str, get_code: Callable[[str, bool], str]) -> None:
        """Have Apple accept a verification code. route: "trusted" (the devices) or "sms".

        Apple pushes a code to the trusted devices by itself as the sign-in finishes, and since
        2026-10 answers requests for another one with HTTP 403 (isideload #27, xtool #349, CapMac's
        second live run). So for the devices we only validate; a code made on the iPhone (Settings,
        Get Verification Code) validates too. A text is still requested, but Apple asks for one only
        when no Apple device has the account, and since 2026-10 won't send it to a sign-in like
        ours (xtool #345, iloader #995). Then no code can come, so the sign-in stops and says to sign
        in on the iPhone, after which Apple shows the code there (verified live 2026-10-19).
        """
        bag = self._lookup()
        identity = base64.b64encode(f"{login['adsid']}:{login['GsIdmsToken']}".encode()).decode()
        headers = {"Accept": "text/x-xml-plist", "Content-Type": "text/x-xml-plist",
                   "X-Apple-App-Info": XCODE_APP_INFO, "X-Xcode-Version": XCODE_VERSION,
                   "X-Apple-Identity-Token": identity, "User-Agent": AUTH_USER_AGENT,
                   "X-MMe-Client-Info": AUTH_CLIENT_INFO, **self._ani.headers()}

        def send(address: str, body: dict[str, Any] | None = None, extra: dict[str, str] | None = None) -> bytes:
            data = None if body is None else plistlib.dumps(body)
            return self._open(urllib.request.Request(address, data=data, headers={**headers, **(extra or {})},
                                                     method="GET" if data is None else "POST"))

        # SMS uses the phone POST endpoints with plist bodies and the first phone number, as
        # Xcode/xtool do; codes from the devices are checked at the lookup's validateCode.
        phone_id = "1"
        mode = route
        if mode == "sms":
            try:
                send("https://gsa.apple.com/auth/verify/phone/put?mode=sms", {"serverInfo": {"phoneNumber.id": phone_id}})
            except urllib.error.HTTPError as error:
                log(f"two-factor: Apple would not text a code (HTTP {error.code})")
                raise GsaError("This Apple Account must be signed in on your iPhone. Apple shows the verification "
                               "code there, and won't text it to CapMac.", NOT_ON_IPHONE) from error
        for attempt in range(3):
            code = get_code(mode, attempt > 0)
            try:
                if mode == "sms":
                    answer = send("https://gsa.apple.com/auth/verify/phone/securitycode?referrer=/auth/verify/phone/put",
                                  {"securityCode.code": code, "serverInfo": {"mode": "sms", "phoneNumber.id": phone_id}})
                else:
                    answer = send(bag["validateCode"], extra={"security-code": code})
                failed, message = reply_status(answer)
            except urllib.error.HTTPError as error:
                failed, message = reply_status(error.read())
                failed = failed or (-21669 if error.code in (400, 401) else error.code)
            if not failed:
                return
            if failed != -21669:
                raise GsaError(message or f"Apple did not accept the verification code ({failed}).", failed)
            log("two-factor: Apple says the code is wrong")
        raise GsaError("That verification code was not accepted.", -21669)

    def authenticate(self, username: str, password: str, get_code: Callable[[str, bool], str]) -> dict[str, Any]:
        username = username.lower()  # GSA requires the Apple ID in lowercase for SRP
        for attempt in range(2):
            srp = SRPClient()
            srp.add_string("s2k,s2k_fo")
            srp.add_string("|")
            init = self._operation({"A2k": srp.public_key(), "ps": ["s2k", "s2k_fo"],
                                    "u": username, "o": "init"})
            srp.add_string("|")
            srp.add_string(init["sp"])
            m1 = srp.process_challenge(username, password, init["s"], init["i"],
                                       init["sp"] == "s2k_fo", init["B"])
            done = self._operation({"c": init["c"], "M1": m1, "u": username, "o": "complete"})
            srp.add_string("|")
            srp.add_data(done["spd"])
            srp.add_string("|")
            if done.get("sc") is not None:
                srp.add_data(done["sc"])
            srp.add_string("|")
            if not (srp.verify_hamk(done["M2"]) and srp.verify_neg_proto(done["np"])):
                raise GsaError("Apple's sign-in response could not be verified.")
            try:
                plain = srp.decrypt(done["spd"])
            except ValueError as error:
                log(f"sign-in reply: {len(done['spd'])} encrypted bytes did not decrypt: {error}")
                raise GsaError("Apple's sign-in reply could not be decrypted.") from error
            reply = read_reply(plain, "sign-in reply")
            status = done.get("Status") or {}
            route = second_factor_route(reply, status)
            if route:
                if attempt:
                    raise GsaError("Two-factor authentication could not be completed.")
                log(f"two-factor: Apple wants a code ({route}; au={status.get('au')!r}, hsc={status.get('hsc')!r}, "
                    f"status-code={reply.get('status-code')!r}, url={reply.get('url')!r})")
                self._two_factor(require(reply, "sign-in reply", "adsid", "GsIdmsToken"), route, get_code)
                continue
            return require(reply, "sign-in reply", "adsid", "GsIdmsToken", "sk", "c")
        raise GsaError("Two-factor authentication could not be completed.")

    def xcode_token(self, login: dict[str, Any]) -> dict[str, Any]:
        sk = login["sk"]
        checksum = hmac.new(sk, b"apptokens" + login["adsid"].encode() + XCODE_APP_INFO.encode(),
                            hashlib.sha256).digest()
        response = self._operation({"app": [XCODE_APP_INFO], "c": login["c"], "t": login["GsIdmsToken"],
                                    "checksum": checksum, "u": login["adsid"], "o": "apptokens"})
        try:
            plain = decrypt_app_token(response["et"], sk)
        except Exception as error:  # noqa: BLE001 - InvalidTag, or a reply too short to hold a token
            log(f"Xcode token reply: {len(response['et'])} encrypted bytes did not decrypt: {error!r}")
            raise GsaError("Apple's Xcode token could not be decrypted.") from error
        tokens = read_reply(plain, "Xcode token reply").get("t") or {}
        token = tokens.get(XCODE_APP_INFO)
        if not isinstance(token, dict):
            log(f"Xcode token reply has tokens for {sorted(tokens)}")
            raise GsaError("Apple did not send the Xcode sign-in token.")
        token = require(token, "Xcode token", "token", "expiry")
        return {"adsid": login["adsid"], "token": token["token"], "expiry": int(token["expiry"])}  # ms epoch

    def sign_in(self, username: str, password: str, get_code: Callable[[str, bool], str]) -> dict[str, Any]:
        """Sign in and fetch the Xcode token as one job: isideload #27 saw fresh sign-ins repeated
        within minutes refused with -22406 ("enter the correct password") even with the right one."""
        login = self.authenticate(username, password, get_code)
        try:
            return self.xcode_token(login)
        except GsaError as error:
            if error.code != -22411:
                raise
        # Apple sometimes pushes a code without saying so in the sign-in reply; the token request
        # then fails with -22411 until that code is entered (isideload #27).
        log("Xcode token: Apple wants the verification code first (-22411)")
        self._two_factor(login, "trusted", get_code)
        return self.xcode_token(self.authenticate(username, password, get_code))


# --- Apple Developer Services (the APIs Xcode uses; work with free personal teams) -------------

class DsError(Exception):
    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.code = code


class DeveloperServices:
    def __init__(self, anisette: Anisette, token: dict[str, Any]) -> None:
        self._ani = anisette
        self._token = token
        self._ssl = tls_context()

    def _auth_headers(self) -> dict[str, str]:
        return {"X-Apple-I-Identity-Id": self._token["adsid"], "X-Apple-App-Info": XCODE_APP_INFO,
                "X-Apple-GS-Token": self._token["token"], "X-Xcode-Version": XCODE_VERSION,
                "X-MMe-Client-Info": AUTH_CLIENT_INFO, "User-Agent": "Xcode", **self._ani.headers()}

    def classic(self, action: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """The legacy .action plist API (used for listing teams)."""
        url = f"{DS2}/{SERVICE_PROTOCOL_VERSION}/{action}.action?clientId={SERVICE_CLIENT_ID}"
        body: dict[str, Any] = dict(params or {})
        body.update({"requestId": str(uuid.uuid4()).upper(), "clientId": SERVICE_CLIENT_ID,
                     "protocolVersion": SERVICE_PROTOCOL_VERSION, "userLocale": ["en_US"]})
        headers = {"Content-Type": "text/x-xml-plist", "Accept": "text/x-xml-plist", **self._auth_headers()}
        req = urllib.request.Request(url, data=plistlib.dumps(body), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30, context=self._ssl) as r:
                result = self._classic_reply(action, r, read_body(r))
        except urllib.error.HTTPError as error:
            try:
                answer = load_plist(read_body(error))
                detail = answer.get("userString") or answer.get("resultString")
            except Exception:  # noqa: BLE001 - an HTML error page
                detail = None
            raise DsError(detail or f"Apple answered HTTP {error.code} to {action}.", error.code) from error
        code = result.get("resultCode", 0)
        if isinstance(code, str):
            code = int(code) if code.lstrip("-").isdigit() else 0
        if code != 0:
            raise DsError(result.get("userString") or result.get("resultString") or "Apple rejected the request", code)
        return result

    @staticmethod
    def _classic_reply(action: str, response: Any, data: bytes) -> dict[str, Any]:
        """A classic reply as a dictionary: a property list, or JSON. Anything else is logged by its
        shape only (status, type, size, first bytes), since a reply can hold account details."""
        try:
            reply = load_plist(data)
        except Exception:  # noqa: BLE001 - plistlib and expat raise several kinds
            try:
                reply = json.loads(data)
            except ValueError:
                reply = None
        if isinstance(reply, dict):
            return reply
        headers = getattr(response, "headers", None) or {}
        log(f"{action}: HTTP {getattr(response, 'status', '?')}, type {headers.get('Content-Type')!r}, "
            f"encoding {headers.get('Content-Encoding')!r}, {describe_reply(data)}")
        raise DsError(f"Apple's developer service sent a reply CapMac couldn't read ({action}).")

    def api(self, method: str, path: str, attributes: dict[str, Any] | None = None,
            relationships: dict[str, Any] | None = None, type_name: str | None = None,
            query: dict[str, str] | None = None) -> dict[str, Any]:
        """The /v1 JSON:API Xcode uses on developerservices2 (team id injected, GET/DELETE tunnelled)."""
        team = self._token["teamId"]
        # urllib asks for plain replies ("identity"); read_body unpacks one that comes compressed anyway.
        headers = {"Accept": "application/vnd.api+json", "Content-Type": "application/vnd.api+json",
                   **self._auth_headers()}
        url = DS2 + path
        if method in ("GET", "DELETE"):
            items = dict(query or {})
            items["teamId"] = team
            encoded = "&".join(f"{urllib.parse.quote(k)}={urllib.parse.quote(v)}" for k, v in items.items())
            headers["X-HTTP-Method-Override"] = method
            data = json.dumps({"urlEncodedQueryParams": encoded}).encode()
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        else:
            attrs = dict(attributes or {})
            attrs["teamId"] = team
            payload: dict[str, Any] = {"data": {"type": type_name, "attributes": attrs}}
            if relationships:
                payload["data"]["relationships"] = relationships
            req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30, context=self._ssl) as r:
                raw = read_body(r)
        except urllib.error.HTTPError as error:
            raw = read_body(error)
            try:
                errors = json.loads(raw).get("errors", [])
                detail = "; ".join(filter(None, (e.get("detail") or e.get("title") for e in errors)))
            except Exception:
                detail = f"HTTP {error.code}"
            raise DsError(detail or f"HTTP {error.code}", error.code) from error
        return json.loads(raw) if raw else {}

    # -- team listing (classic) --------------------------------------------------------------
    def teams(self) -> list[dict[str, Any]]:
        teams = self.classic("listTeams").get("teams", [])
        out = []
        for team in teams:
            memberships = team.get("memberships", [])
            paid = any(m.get("platform") == "ios" and "Apple Developer Program" in str(m.get("name", "")) for m in memberships)
            out.append({"id": team.get("teamId"), "name": team.get("name", team.get("teamId")),
                        "status": team.get("status"), "free": not paid})
        return out


# --- provisioning: a development certificate, the device, App IDs and 7-day profiles ----------
# All through the /v1 JSON:API Xcode uses, which free personal teams can use.

def _iso(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _make_certificate(ds: DeveloperServices, directory: str, notes: list[str]) -> dict[str, Any]:
    """Reuse this PC's development certificate while Apple still lists it; otherwise make a new one.

    A free team keeps only a couple of development certificates, so a new one means
    revoking those we can no longer use (xtool does the same).
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12

    key_file = os.path.join(directory, "free-development.key")
    meta_file = os.path.join(directory, "free-development.json")
    listed = ds.api("GET", "/v1/certificates").get("data", [])
    now = datetime.datetime.now(datetime.timezone.utc)

    saved: dict[str, Any] | None = None
    if os.path.exists(key_file) and os.path.exists(meta_file):
        try:
            with open(meta_file, encoding="utf-8") as f:
                saved = json.load(f)
        except Exception:
            saved = None
    if saved and saved.get("id"):
        match = next((c for c in listed if str(c.get("attributes", {}).get("serialNumber", "")).lstrip("0").upper()
                      == str(saved.get("serial", "")).lstrip("0").upper()), None)
        expiry = datetime.datetime.fromisoformat(saved["notAfter"]) if saved.get("notAfter") else None
        if match and expiry and expiry > now + datetime.timedelta(days=1):
            with open(key_file, "rb") as f:
                key = serialization.load_pem_private_key(f.read(), password=None)
            cert = x509.load_der_x509_certificate(base64.b64decode(saved["cert"]))
            password = base64.urlsafe_b64encode(secrets.token_bytes(18)).decode().rstrip("=")
            p12 = pkcs12.serialize_key_and_certificates(b"CapMac Development", key, cert, None,
                                                        serialization.BestAvailableEncryption(password.encode()))
            return {"p12": base64.b64encode(p12).decode(), "password": password,
                    "serial": saved["serial"], "notAfter": saved["notAfter"], "id": saved["id"]}

    # Only revoke a certificate CapMac itself made before (matched by our saved serial); never
    # touch certificates from other machines or tools. A free team's small cap is reported, not
    # worked around by deleting unrelated identities.
    if saved and saved.get("serial"):
        ours = str(saved["serial"]).lstrip("0").upper()
        for cert in listed:
            if str(cert.get("attributes", {}).get("serialNumber", "")).lstrip("0").upper() == ours:
                try:
                    ds.api("DELETE", f"/v1/certificates/{cert['id']}")
                except DsError as error:
                    notes.append(f"Could not remove CapMac's old certificate: {error}")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (x509.CertificateSigningRequestBuilder()
           .subject_name(x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "CapMac Development")]))
           .sign(key, hashes.SHA256()))
    csr_pem = csr.public_bytes(serialization.Encoding.PEM).decode()
    try:
        created = ds.api("POST", "/v1/certificates", type_name="certificates",
                         attributes={"csrContent": csr_pem, "certificateType": "DEVELOPMENT"})
    except DsError as error:
        if any(word in str(error).lower() for word in ("maximum", "limit", "already")):
            raise DsError("Apple won't make another development certificate for this account. Revoke one you "
                          "don't use at developer.apple.com/account/resources/certificates, then try again.",
                          error.code) from error
        raise
    attrs = created.get("data", {}).get("attributes", {})
    content = attrs.get("certificateContent")
    if not content:
        raise DsError("Apple did not return a development certificate.")
    cert = x509.load_der_x509_certificate(base64.b64decode(content))
    not_after = _iso(cert.not_valid_after_utc if hasattr(cert, "not_valid_after_utc") else cert.not_valid_after)
    serial = str(attrs.get("serialNumber") or format(cert.serial_number, "X"))
    password = base64.urlsafe_b64encode(secrets.token_bytes(18)).decode().rstrip("=")
    with open(key_file, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()))
    with open(meta_file, "w", encoding="utf-8") as f:
        json.dump({"serial": serial, "notAfter": not_after, "cert": content, "id": created["data"]["id"]}, f)
    p12 = pkcs12.serialize_key_and_certificates(b"CapMac Development", key, cert, None,
                                                serialization.BestAvailableEncryption(password.encode()))
    return {"p12": base64.b64encode(p12).decode(), "password": password, "serial": serial, "notAfter": not_after,
            "id": created["data"]["id"]}


def _ensure_device(ds: DeveloperServices, device: dict[str, Any] | None, notes: list[str]) -> list[str]:
    """Register the plugged-in iPhone and return every enabled device id.

    If a specific iPhone was asked for, it must end up registered: a failure is raised,
    never swallowed, so we can't quietly build a profile for a different phone.
    """
    requested = str(device["udid"]).upper() if device and device.get("udid") else None
    if requested:
        try:
            ds.api("POST", "/v1/devices", type_name="devices",
                   attributes={"name": str(device.get("name") or "iPhone")[:50], "platform": "IOS",
                               "udid": str(device["udid"])})
        except DsError as error:
            if error.code != 409:  # 409 = already registered, which is fine
                raise DsError(f"Could not register this iPhone with Apple: {error}", error.code) from error
    listed = ds.api("GET", "/v1/devices").get("data", [])
    enabled = [d for d in listed if d.get("attributes", {}).get("status", "ENABLED") == "ENABLED"
               and str(d.get("attributes", {}).get("deviceClass", "IPHONE")).upper() in ("IPHONE", "IPAD", "IPOD")]
    if requested and not any(str(d.get("attributes", {}).get("udid", "")).upper() == requested for d in enabled):
        raise DsError("Apple didn't register this iPhone for development. Unlock it and tap Trust, and note a free "
                      "account allows only 3 devices.")
    ids = [d["id"] for d in enabled]
    if not ids:
        raise DsError("Your Apple team has no iPhone registered. Plug in your iPhone, unlock it and tap Trust.")
    return ids


def _ensure_bundle_id(ds: DeveloperServices, identifier: str, notes: list[str]) -> str:
    found = ds.api("GET", "/v1/bundleIds", query={"filter[identifier]": identifier}).get("data", [])
    exact = next((b for b in found if b.get("attributes", {}).get("identifier") == identifier), None)
    if exact:
        return exact["id"]
    name = ("CapMac " + identifier).replace("-", " ")
    name = "".join(ch if ch.isalnum() or ch == " " else " " for ch in name)
    try:
        created = ds.api("POST", "/v1/bundleIds", type_name="bundleIds",
                         attributes={"name": name, "platform": "IOS", "identifier": identifier})
    except DsError as error:
        # An app ID belongs to one team. Apple answers 409 "An App ID with Identifier '…' is not
        # available. Please enter a different string." when another team (a paid one too) has it.
        if error.code == 409 or "not available" in str(error).lower():
            raise DsError(f"Another Apple team already has the app ID {identifier}, so your free team can't use it. "
                          "Give the app a bundle ID of your own (for example com.yourname.appname), then run setup "
                          "again.", error.code) from error
        raise
    return created["data"]["id"]


def _enable_capabilities(ds: DeveloperServices, bundle_id: str, capabilities: list[str], notes: list[str]) -> None:
    for capability in capabilities:
        try:
            ds.api("POST", "/v1/bundleIdCapabilities", type_name="bundleIdCapabilities",
                   attributes={"capabilityType": capability},
                   relationships={"bundleId": {"data": {"type": "bundleIds", "id": bundle_id}}})
        except DsError as error:
            notes.append(f"Could not turn on {capability}: {error}")


def _ensure_app_groups(ds: DeveloperServices, bundle_identifier: str, groups: list[str], notes: list[str]) -> None:
    """Register each app group and assign it to the App ID, through the classic API (the /v1 API
    Xcode uses here has no app-group resource). Best-effort: a failure is reported, not fatal."""
    team = ds._token["teamId"]
    try:
        app_ids = ds.classic("ios/listAppIds", {"teamId": team}).get("appIds", [])
        app_id_id = next((a.get("appIdId") for a in app_ids if a.get("identifier") == bundle_identifier), None)
        if not app_id_id:
            notes.append("App Groups weren't assigned: Apple didn't list the App ID yet. Run setup again in a minute.")
            return
        existing = {g.get("identifier"): g.get("applicationGroup")
                    for g in ds.classic("ios/listApplicationGroups", {"teamId": team}).get("applicationGroupList", [])}
        group_ids = []
        for group in groups:
            group_id = existing.get(group)
            if not group_id:
                made = ds.classic("ios/addApplicationGroup", {"teamId": team, "identifier": group, "name": "CapMac " + group})
                group_id = made.get("applicationGroup", {}).get("applicationGroup")
            if group_id:
                group_ids.append(group_id)
        if group_ids:
            ds.classic("ios/assignApplicationGroupToAppId", {"teamId": team, "appIdId": app_id_id, "applicationGroups": group_ids})
    except DsError as error:
        notes.append(f"App Groups may need to be set up by hand at developer.apple.com: {error}")


def provision(ds: DeveloperServices, targets: list[dict[str, Any]], device: dict[str, Any] | None,
              directory: str) -> dict[str, Any]:
    os.makedirs(directory, exist_ok=True)
    notes: list[str] = []
    certificate = _make_certificate(ds, directory, notes)
    device_ids = _ensure_device(ds, device, notes)
    profiles: dict[str, str] = {}
    stamp = datetime.datetime.now().strftime("%Y%m%d%H%M")
    for target in targets:
        identifier = str(target["bundleIdentifier"])
        bundle_id = _ensure_bundle_id(ds, identifier, notes)
        _enable_capabilities(ds, bundle_id, list(target.get("capabilities", [])), notes)
        groups = [str(group) for group in target.get("appGroups", []) if group]
        if groups:
            _ensure_app_groups(ds, identifier, groups, notes)
        created = ds.api("POST", "/v1/profiles", type_name="profiles",
                         attributes={"name": f"CapMac {identifier} {stamp}", "profileType": "IOS_APP_DEVELOPMENT"},
                         relationships={
                             "bundleId": {"data": {"type": "bundleIds", "id": bundle_id}},
                             "certificates": {"data": [{"type": "certificates", "id": certificate["id"]}]},
                             "devices": {"data": [{"type": "devices", "id": d} for d in device_ids]}})
        content = created.get("data", {}).get("attributes", {}).get("profileContent")
        if not content:
            raise DsError(f"Apple did not return a profile for {identifier}.")
        profiles[identifier] = content
    return {"certificate": {"serial": certificate["serial"], "notAfter": certificate["notAfter"]},
            "p12": certificate["p12"], "password": certificate["password"], "profiles": profiles, "notes": notes}


def main() -> int:
    if len(sys.argv) < 2:
        log("usage: apple-free.py <state-dir>")
        return 2
    state_dir = sys.argv[1]
    use_windows_trust()  # before anything connects, so anisette's own requests use it too
    anisette: Anisette | None = None
    gsa: GrandSlamClient | None = None
    token: dict[str, Any] | None = None

    def reply(obj: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    def read_message() -> dict[str, Any] | None:
        line = sys.stdin.readline()
        if not line:
            return None
        return json.loads(line)

    def get_code(mode: str, again: bool = False) -> str:
        reply({"event": "need-code", "mode": mode, "again": again})
        msg = read_message()
        if not msg or msg.get("op") != "code" or not msg.get("code"):
            raise GsaError("No verification code was provided.")
        return str(msg["code"]).strip()

    for raw in iter(read_message, None):
        op = raw.get("op")
        rid = raw.get("id")
        try:
            if op == "shutdown":
                return 0
            if op == "login":
                anisette = Anisette(state_dir)
                gsa = GrandSlamClient(anisette)
                base = gsa.sign_in(str(raw["username"]), str(raw["password"]), get_code)
                token = base
                ds = DeveloperServices(anisette, {**base, "teamId": ""})
                reply({"id": rid, "ok": True, "result": {"teams": ds.teams(),
                       "expiry": base["expiry"]}})
            elif op == "provision":
                if anisette is None or token is None:
                    raise DsError("Sign in before provisioning.")
                result = provision(DeveloperServices(anisette, {**token, "teamId": str(raw["teamId"])}),
                                   raw.get("targets", []), raw.get("device"),
                                   str(raw.get("dir") or state_dir))
                reply({"id": rid, "ok": True, "result": result})
            else:
                reply({"id": rid, "ok": False, "error": f"Unknown request: {op}"})
        except (GsaError, DsError) as error:
            reply({"id": rid, "ok": False, "error": str(error), "code": getattr(error, "code", None)})
        except Exception as error:  # noqa: BLE001 - surface a clean message, keep the server alive
            log(f"error: {error!r}")
            reply({"id": rid, "ok": False, "error": str(error) or error.__class__.__name__})
    return 0


if __name__ == "__main__":
    sys.exit(main())
