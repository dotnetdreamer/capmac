# capmac Studio: code signing and updates

How capmac Studio's Windows builds get signed and how installed copies update themselves. Everything is driven by environment variables at build time (`apps/desktop/scripts/release-config.mjs`); without them, `npm run desktop:build` makes the same unsigned builds as before, with updates off.

## Decision 1: how to sign

Windows shows unsigned installers as "Unknown publisher", and SmartScreen blocks them with "Windows protected your PC". Auto-update also relies on signing: an update is only installed if it is signed by the same publisher as the running app.

| | Azure Artifact Signing (formerly Trusted Signing) | OV certificate | EV certificate |
|---|---|---|---|
| Cost | $9.99 a month (Basic: 5,000 signatures, one certificate profile) | about $120–$440 a year, depending on the vendor | about $290–$620 a year |
| Who can get it | Organizations and individuals in the US and Canada; organizations (not individuals) in the EU and UK | Organizations and individuals, worldwide | Registered organizations only |
| Identity check | Microsoft validates the organization or person, once (days) | The certificate authority validates you (days) | A stricter organization check (days to weeks) |
| Where the key lives | In Azure; you never hold it | A USB token or a cloud HSM (required since June 2023) | A USB token or a cloud HSM |
| Signing on a build machine | An Azure app registration's secret in the environment | Token plugged in (or the vendor's cloud signing tool) | Same as OV |
| SmartScreen | Builds reputation with downloads | Builds reputation with downloads | Same as OV (EV no longer skips the warning) |
| Effort in capmac | Ready: set 7 variables | Ready: `CSC_LINK` + password, or a thumbprint for a token | Ready: a thumbprint for the token |

**Recommendation:** Azure Artifact Signing if you can get it (US or Canada, or as an organization in the EU or UK). It is the cheapest, needs no hardware and works unattended on any build machine. Otherwise, an OV certificate in a cloud HSM or on a token; EV adds cost without a SmartScreen benefit any more.

What I need from you: either the Azure details (endpoint, account, certificate profile, publisher name, and an app registration allowed to sign), or a certificate. I'll then run a signed build and check every file with `Get-AuthenticodeSignature`.

Sources: [DevClass on Artifact Signing (January 2026)](https://devclass.com/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/), [Azure pricing](https://azure.microsoft.com/pricing/details/artifact-signing/), [code signing certificate prices (SSL Insights)](https://sslinsights.com/best-code-signing-certificate-for-windows-application/). Prices change: check before buying.

## Decision 2: where updates live

The app checks an HTTPS folder (electron-builder's *generic* provider) for `latest.yml`, then downloads the installer it names. Any static host works:

- **GitHub Releases:** needs this repository on GitHub and a token to upload. The feed URL is then the release download folder, or electron-builder's GitHub provider.
- **A bucket** (Cloudflare R2, S3, Azure Blob) or any web server: upload the files after each build.

The feed is one variable, `CAPMAC_UPDATE_URL`, so the choice can change later.

## Signing a build

Set one of these before `npm run desktop:build`:

```powershell
# Azure Artifact Signing (electron-builder 26 calls it azureSignOptions)
$env:CAPMAC_AZURE_SIGNING_ENDPOINT = 'https://weu.codesigning.azure.net/'   # your account's region
$env:CAPMAC_AZURE_SIGNING_ACCOUNT  = '<code signing account>'
$env:CAPMAC_AZURE_SIGNING_PROFILE  = '<certificate profile>'
$env:CAPMAC_SIGNING_PUBLISHER      = 'CN=<exactly as in the certificate>'
$env:AZURE_TENANT_ID = '…'; $env:AZURE_CLIENT_ID = '…'; $env:AZURE_CLIENT_SECRET = '…'

# …or a certificate file (.pfx) and its password
$env:CSC_LINK = 'C:\path\to\certificate.pfx'; $env:CSC_KEY_PASSWORD = '…'

# …or a certificate on a token or in the Windows certificate store, by thumbprint
$env:CAPMAC_SIGNING_SHA1 = '<thumbprint>'
```

Optional: `CAPMAC_TIMESTAMP_URL` (default `http://timestamp.digicert.com`).

The build signs, with SHA-256 and a timestamp:

- `capmac Studio.exe`;
- `elevate.exe` (used by the installer to install for all users);
- the uninstaller;
- the installer;
- the portable exe.

A half-configured Azure setup stops the build and names the missing variables. No secret is written to disk or to the build output.

Azure signing runs Microsoft's `Invoke-TrustedSigning` PowerShell module, which electron-builder installs for the current user on first use.

**Verify** a signed build:

```powershell
Get-ChildItem apps\desktop\release\<version> -Recurse -Include 'capmac Studio.exe','elevate.exe','*-setup.exe','*-portable.exe' |
  Get-AuthenticodeSignature | Format-Table Status, @{n='File';e={Split-Path $_.Path -Leaf}}, @{n='Signer';e={$_.SignerCertificate.Subject}}
```

Every row should say `Valid`. The build pipeline was checked with a throwaway self-signed certificate: all five files were signed and timestamped by DigiCert (`UnknownError` only because a self-signed certificate is not trusted).

## Publishing an update

1. Build with the feed set, signed:

   ```powershell
   $env:CAPMAC_UPDATE_URL = 'https://<host>/capmac-studio/'          # the folder that will hold the files
   $env:CAPMAC_RELEASE_NOTES_URL = 'https://<host>/notes/{version}'   # optional: "Release notes" in the app
   npm run desktop:build                                              # version from apps/desktop/package.json
   ```

2. Upload from `apps/desktop/release/<version>/` to that folder:
   - `latest.yml`, which tells installed apps about the new version;
   - `capmac-studio-<version>-<arch>-setup.exe` and its `.blockmap`;
   - `capmac-studio-<version>-<arch>-portable.exe`, which portable users download by hand.

   Keep the previous versions' `.blockmap` files in the folder: with them, an update downloads only the blocks that changed.

3. Upload `latest.yml` last, so no app sees the new version before its installer is there.

## How the app behaves

- **Checks:** 15 seconds after start, then every 4 hours, and on *Check for updates* in Settings › About.
- **Download:** in the background. Nothing interrupts a running session.
- **Install:**
  - when the update is ready, an InfoBar says "capmac Studio 0.2.0 is ready", with *Restart to update*; Settings and the tray menu offer the same;
  - with a session running, restarting first asks for confirmation;
  - otherwise the update installs when capmac Studio quits.
- **Portable exe:** it cannot replace itself, so it shows "capmac Studio 0.2.0 is available" with a link to the new portable exe.
- **Without a feed** (a local build, a development build), Settings › About says updates are off.

**Signature check:** a signed build records its publisher in `resources/app-update.yml`. Before installing, the updater checks that the new installer is signed by that same publisher (`verifyUpdateCodeSignature`).

**The risk while builds are unsigned:** there is no publisher to check. The updater still verifies the download against the SHA-512 in `latest.yml`, but whoever controls the update host could publish a different installer. Until builds are signed, serve the feed over HTTPS from a host only you can write to, or leave `CAPMAC_UPDATE_URL` unset.

## Testing updates without installing

This is how the update path was verified on this PC, without installing anything:

1. `CAPMAC_UPDATE_URL=http://127.0.0.1:47219/ npm run dist -w @capmac/desktop -- --x64`, then copy `release\0.1.0\win-unpacked` aside: the "installed" old version.
2. `CAPMAC_VERSION=0.2.0`, the same build again: the new version, with its `latest.yml`, installer and blockmap.
3. Serve `release\0.2.0` on that port with any static server that supports byte ranges.
4. Start the old `capmac Studio.exe` with `CAPMAC_VIA=update-test`, `CAPMAC_STUDIO_USER_DATA` and `CAPMAC_CONFIG_DIR` set to temp folders. `CAPMAC_VIA` keeps the packaged build from turning on terminal takeover.

It found 0.2.0, downloaded it in the background, and showed the InfoBar and *Restart to update*. The portable exe showed the download link instead.

Stop the app with `taskkill /F`: quitting normally would install the update. Then delete `%LOCALAPPDATA%\@capmacdesktop-updater`.
