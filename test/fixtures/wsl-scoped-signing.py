"""Exercise real CMS signing and per-bundle XML/DER entitlements without an Apple SDK."""
import datetime
import json
import os
import pathlib
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid


def command(argv, **options):
    result = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
    if result.returncode:
        raise RuntimeError("Command failed: " + argv[0] + "\n" + result.stdout + "\n" + result.stderr)
    return result


def write_plist(filename, value):
    filename.parent.mkdir(parents=True, exist_ok=True)
    filename.write_bytes(plistlib.dumps(value))


def signature_slots(filename):
    data = filename.read_bytes()
    if data[:4] != b"\xcf\xfa\xed\xfe":
        raise AssertionError("Expected a thin arm64 Mach-O fixture")
    offset = 32
    signature = None
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        kind, size = struct.unpack_from("<II", data, offset)
        if kind == 0x1D:
            start, length = struct.unpack_from("<II", data, offset + 8)
            signature = data[start:start + length]
        offset += size
    if signature is None:
        raise AssertionError("The signer did not write LC_CODE_SIGNATURE")
    magic, length, count = struct.unpack_from(">III", signature)
    if magic != 0xFADE0CC0 or length > len(signature):
        raise AssertionError("Invalid embedded signature superblob")
    slots = {}
    for index in range(count):
        kind, offset = struct.unpack_from(">II", signature, 12 + index * 8)
        _magic, size = struct.unpack_from(">II", signature, offset)
        slots[kind] = signature[offset:offset + size]
    return slots


def der_value(data, offset=0):
    tag = data[offset]
    size = data[offset + 1]
    begin = offset + 2
    if size & 0x80:
        count = size & 0x7F
        size = int.from_bytes(data[begin:begin + count], "big")
        begin += count
    end = begin + size
    if end > len(data):
        raise AssertionError("Truncated DER entitlement value")
    if tag == 0x0C:
        value = data[begin:end].decode("utf-8")
    elif tag == 0x01:
        value = data[begin] != 0
    elif tag == 0x02:
        value = int.from_bytes(data[begin:end], "big")
    elif tag in (0x30, 0xB0, 0x70):
        children = []
        position = begin
        while position < end:
            child, position = der_value(data, position)
            children.append(child)
        if tag == 0xB0:
            value = dict(children)
        elif tag == 0x70:
            if children[0] != 1:
                raise AssertionError("Unexpected DER entitlement version")
            value = children[1]
        else:
            value = children
    else:
        raise AssertionError("Unexpected DER entitlement tag " + hex(tag))
    return value, end


def inspect_binary(filename, root):
    slots = signature_slots(filename)
    result = {"slots": sorted(slots)}
    if 5 in slots:
        result["xml"] = plistlib.loads(slots[5][8:].rstrip(b"\0"))
    if 7 in slots:
        result["der"] = der_value(slots[7][8:])[0]
    if 0x10000 not in slots or 0 not in slots:
        raise AssertionError("A real CMS signature and CodeDirectory are required")
    cms = root / (filename.name + ".cms")
    directory = root / (filename.name + ".codedirectory")
    cms.write_bytes(slots[0x10000][8:])
    directory.write_bytes(slots[0])
    command(["openssl", "cms", "-verify", "-noverify", "-binary", "-inform", "DER",
             "-in", str(cms), "-content", str(directory), "-out", str(root / "verified.bin")])
    result["cmsVerified"] = True
    return result


signer = sys.argv[1]
clang = shutil.which("clang")
linker = shutil.which("ld64.lld") or shutil.which("ld64.lld-18")
if not clang or not linker:
    raise SystemExit("The real signing fixture needs Clang and the Mach-O LLD linker")

with tempfile.TemporaryDirectory(prefix="capmac-scoped-signing-") as temporary:
    root = pathlib.Path(temporary)
    app = root / "Scoped.app"
    widget = app / "PlugIns/Widget.appex"
    framework = app / "Frameworks/Helper.framework"
    app.mkdir()
    widget.mkdir(parents=True)
    framework.mkdir(parents=True)
    source = root / "main.c"
    source.write_text("int main(void) { return 0; }\n")
    obj = root / "main.o"
    command([clang, "-target", "arm64-apple-ios15.0", "-ffreestanding", "-fno-stack-protector",
             "-c", str(source), "-o", str(obj)])
    for folder, executable, bundle_id, package in [
        (app, "Scoped", "dev.capmac.scoped", "APPL"),
        (widget, "Widget", "dev.capmac.scoped.widget", "XPC!"),
        (framework, "Helper", "dev.capmac.helper", "FMWK"),
    ]:
        write_plist(folder / "Info.plist", {"CFBundleIdentifier": bundle_id,
                    "CFBundleExecutable": executable, "CFBundleName": executable,
                    "CFBundleVersion": "1", "CFBundlePackageType": package})
        args = [linker, "-arch", "arm64", "-platform_version", "ios", "15.0", "26.2"]
        if package == "FMWK":
            args += ["-dylib", "-install_name", "@rpath/Helper.framework/Helper"]
        else:
            args += ["-e", "_main"]
        command(args + [str(obj), "-o", str(folder / executable)])
    key = root / "identity.key"
    cert = root / "identity.pem"
    ca_key = root / "test-ca.key"
    ca_cert = root / "test-ca.pem"
    request = root / "identity.csr"
    command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
             "-subj", "/CN=CapMac Synthetic Test CA/O=CapMac",
             "-keyout", str(ca_key), "-out", str(ca_cert)])
    command(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
             "-subj", "/CN=CapMac Synthetic Signing Test/O=CapMac/OU=TEAMTEST01",
             "-keyout", str(key), "-out", str(request)])
    command(["openssl", "x509", "-req", "-in", str(request), "-CA", str(ca_cert),
             "-CAkey", str(ca_key), "-CAcreateserial", "-days", "1", "-out", str(cert)])
    identity = root / "identity.p12"
    command(["openssl", "pkcs12", "-export", "-inkey", str(key), "-in", str(cert),
             "-certfile", str(ca_cert), "-passout", "pass:", "-out", str(identity)])
    certificate = root / "identity.der"
    command(["openssl", "x509", "-in", str(cert), "-outform", "DER", "-out", str(certificate)])
    requested = {}
    profiles = []
    for role, bundle_id in [("main", "dev.capmac.scoped"), ("extension", "dev.capmac.scoped.widget")]:
        entitlements = {"application-identifier": "TEAMTEST01." + bundle_id,
                        "com.apple.developer.team-identifier": "TEAMTEST01", "get-task-allow": False,
                        "com.apple.security.application-groups": ["group.dev.capmac.shared"],
                        "com.capmac." + role + "-only": True}
        requested[bundle_id] = entitlements
        entitlements_file = root / (role + ".entitlements.plist")
        write_plist(entitlements_file, entitlements)
        profile = root / (role + ".profile.plist")
        write_plist(profile, {"UUID": str(uuid.uuid4()).upper(), "Name": "Synthetic " + role,
                    "TeamIdentifier": ["TEAMTEST01"], "ApplicationIdentifierPrefix": ["TEAMTEST01"],
                    "CreationDate": datetime.datetime.now(datetime.timezone.utc),
                    "ExpirationDate": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1),
                    "ProvisionedDevices": ["synthetic-test-device"], "Version": 1,
                    "DeveloperCertificates": [certificate.read_bytes()],
                    "Entitlements": {**entitlements, "com.capmac.profile-only": True}})
        output = root / (role + ".mobileprovision")
        command(["openssl", "cms", "-sign", "-signer", str(cert), "-inkey", str(key),
                 "-in", str(profile), "-outform", "DER", "-out", str(output), "-nodetach", "-binary"])
        profiles.append(output)
    manifest = root / "entitlements.json"
    manifest.write_text(json.dumps({"dev.capmac.scoped": str(root / "main.entitlements.plist"),
                                   "dev.capmac.scoped.widget": str(root / "extension.entitlements.plist")}))
    environment = {**os.environ, "CAPMAC_ZSIGN_ENTITLEMENTS_MAP": str(manifest)}
    # Global -e reproduces upstream's inheritance bug; the scoped patch must
    # select each bundle's own dictionary and remove app entitlements from dylibs.
    signing = [signer, "-f", "-k", str(identity), "-p", "", "-c", str(cert), "-e", str(root / "main.entitlements.plist")]
    for profile in profiles:
        signing += ["-m", str(profile)]
    command(signing + [str(app)], env=environment, cwd=str(root))
    main = inspect_binary(app / "Scoped", root)
    extension = inspect_binary(widget / "Widget", root)
    helper = inspect_binary(framework / "Helper", root)
    assert main["xml"] == requested["dev.capmac.scoped"]
    assert main["der"] == requested["dev.capmac.scoped"]
    assert extension["xml"] == requested["dev.capmac.scoped.widget"]
    assert extension["der"] == requested["dev.capmac.scoped.widget"]
    assert helper.get("xml", {}) == {} and 7 not in helper["slots"]
    for folder, bundle_id in [(app, "dev.capmac.scoped"), (widget, "dev.capmac.scoped.widget")]:
        extracted = root / (folder.stem + ".decoded-profile.plist")
        command(["openssl", "cms", "-verify", "-noverify", "-inform", "DER", "-in",
                 str(folder / "embedded.mobileprovision"), "-out", str(extracted)])
        assert plistlib.loads(extracted.read_bytes())["Entitlements"]["application-identifier"] == "TEAMTEST01." + bundle_id
    manifest.write_text(json.dumps({"dev.capmac.scoped": str(root / "main.entitlements.plist")}))
    missing = subprocess.run(signing + [str(app)], env=environment, cwd=str(root), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert missing.returncode != 0 and "scoped entitlements missing for dev.capmac.scoped.widget" in missing.stdout + missing.stderr
    print(json.dumps({"main": main, "extension": extension, "framework": helper,
                      "embeddedProfilesMatched": True, "missingExtensionRejected": True}))
