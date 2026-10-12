import { promises as fs } from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';
import type { ProjectInfo } from './project.js';

export interface ApiKeyOptions {
  apiKey?: string;
  apiKeyId?: string;
  apiIssuer?: string;
}

export interface ApiKey {
  keyId: string;
  issuerId: string;
  p8: string;
}

/**
 * App Store Connect API key for signing over SSH. Xcode's own account login
 * tends to fail in SSH sessions ("Your session has expired", "No Accounts"),
 * so this is the reliable way to let xcodebuild manage profiles and register
 * devices. Sources, in order: flags, capmac.json `ios.apiKey`, environment.
 */
export async function loadApiKey(options: ApiKeyOptions, project?: ProjectInfo): Promise<ApiKey | undefined> {
  const configured = project?.config.ios?.apiKey;
  const file = options.apiKey ?? (configured?.path ? path.resolve(project!.capDir, configured.path) : undefined) ?? process.env.CAPMAC_ASC_KEY_PATH;
  if (!file) return undefined;
  const keyId = options.apiKeyId ?? configured?.keyId ?? process.env.CAPMAC_ASC_KEY_ID ?? path.basename(file).match(/AuthKey_([A-Z0-9]+)\.p8$/i)?.[1];
  const issuerId = options.apiIssuer ?? configured?.issuerId ?? process.env.CAPMAC_ASC_ISSUER_ID;
  if (!keyId || !issuerId) {
    throw new UserError('An App Store Connect API key needs its key ID and issuer ID.', 'Pass --api-key-id and --api-issuer, set ios.apiKey in capmac.json, or set CAPMAC_ASC_KEY_ID / CAPMAC_ASC_ISSUER_ID.');
  }
  try {
    return { keyId, issuerId, p8: await fs.readFile(file, 'utf8') };
  } catch {
    throw new UserError(`Cannot read the API key file ${file}.`);
  }
}
