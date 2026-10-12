// What a release build adds to electron-builder.yml, from environment variables only:
// code signing and the update feed. With none of them set the build is unsigned and has
// no update feed, which is right for local builds. Nothing secret is ever written to disk:
// certificates and passwords stay in the environment of the build.
//
// Signing, one of:
//   Azure Trusted Signing  CAPMAC_AZURE_SIGNING_ENDPOINT (e.g. https://weu.codesigning.azure.net/),
//                          CAPMAC_AZURE_SIGNING_ACCOUNT, CAPMAC_AZURE_SIGNING_PROFILE,
//                          CAPMAC_SIGNING_PUBLISHER (the certificate's subject, "CN=…"),
//                          plus AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET for the
//                          app registration allowed to sign.
//   A certificate file     CSC_LINK (a .pfx path or base64) and CSC_KEY_PASSWORD (electron-builder's own).
//   A certificate in the   CAPMAC_SIGNING_SHA1, the certificate's thumbprint (an EV or OV certificate
//   Windows store / token  on a hardware token or in Windows' certificate store).
//   Optional               CAPMAC_TIMESTAMP_URL (default http://timestamp.digicert.com),
//                          CAPMAC_SIGNING_PUBLISHER (checked by auto-update before installing).
// Updates:
//   CAPMAC_UPDATE_URL      the feed: a folder on an HTTPS server holding latest.yml, the installers
//                          and their .blockmap files (electron-builder's "generic" provider).
//   CAPMAC_RELEASE_NOTES_URL  release notes, "{version}" replaced (read when out/ is built).

// Any of these turns Azure signing on; the publisher is shared with certificate signing.
const AZURE = ['CAPMAC_AZURE_SIGNING_ENDPOINT', 'CAPMAC_AZURE_SIGNING_ACCOUNT', 'CAPMAC_AZURE_SIGNING_PROFILE'];
const AZURE_REQUIRED = [...AZURE, 'CAPMAC_SIGNING_PUBLISHER', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'];

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ config: Record<string, unknown>, signing: 'azure' | 'certificate' | 'store' | null, notes: string[] }}
 */
export function releaseConfig(env) {
  const notes = [];
  const win = {};
  let signing = null;
  if (AZURE.some((name) => env[name])) {
    const missing = AZURE_REQUIRED.filter((name) => !env[name]);
    if (missing.length) throw new Error(`Azure Trusted Signing is half configured: set ${missing.join(', ')}.`);
    win.azureSignOptions = {
      publisherName: env.CAPMAC_SIGNING_PUBLISHER,
      endpoint: env.CAPMAC_AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName: env.CAPMAC_AZURE_SIGNING_ACCOUNT,
      certificateProfileName: env.CAPMAC_AZURE_SIGNING_PROFILE,
    };
    signing = 'azure';
    notes.push(`signing with Azure Trusted Signing (${env.CAPMAC_AZURE_SIGNING_ACCOUNT} / ${env.CAPMAC_AZURE_SIGNING_PROFILE})`);
  } else if (env.CSC_LINK || env.WIN_CSC_LINK || env.CAPMAC_SIGNING_SHA1) {
    if ((env.CSC_LINK || env.WIN_CSC_LINK) && !(env.CSC_KEY_PASSWORD || env.WIN_CSC_KEY_PASSWORD)) {
      throw new Error('CSC_LINK is set without CSC_KEY_PASSWORD: set the certificate password too.');
    }
    win.signtoolOptions = {
      // SHA-1 signatures stopped counting years ago; one SHA-256 signature, timestamped.
      signingHashAlgorithms: ['sha256'],
      rfc3161TimeStampServer: env.CAPMAC_TIMESTAMP_URL || 'http://timestamp.digicert.com',
      ...(env.CAPMAC_SIGNING_SHA1 ? { certificateSha1: env.CAPMAC_SIGNING_SHA1.replace(/\s/g, '') } : {}),
      ...(env.CAPMAC_SIGNING_PUBLISHER ? { publisherName: env.CAPMAC_SIGNING_PUBLISHER } : {}),
    };
    signing = env.CAPMAC_SIGNING_SHA1 && !(env.CSC_LINK || env.WIN_CSC_LINK) ? 'store' : 'certificate';
    notes.push(signing === 'store' ? 'signing with the certificate in the Windows store or on the token' : 'signing with the certificate in CSC_LINK');
  } else {
    notes.push('unsigned: no signing variables are set (see apps/desktop/scripts/release-config.mjs)');
  }
  // Auto-update checks the installer's signature against the publisher before installing it;
  // an unsigned build has no publisher to check, so there is nothing to verify.
  win.verifyUpdateCodeSignature = signing !== null;

  const config = { win };
  if (env.CAPMAC_UPDATE_URL) {
    const url = env.CAPMAC_UPDATE_URL;
    if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) {
      throw new Error(`CAPMAC_UPDATE_URL must be an https:// address (got ${url}).`);
    }
    config.publish = [{ provider: 'generic', url }];
    notes.push(`updates from ${url}`);
  } else {
    // No feed: no app-update.yml, and capmac Studio says updates are off.
    config.publish = null;
    notes.push('no update feed: set CAPMAC_UPDATE_URL to turn updates on');
  }
  if (env.CAPMAC_VERSION) {
    config.extraMetadata = { version: env.CAPMAC_VERSION };
    notes.push(`version ${env.CAPMAC_VERSION}`);
  }
  return { config, signing, notes };
}
