/**
 * Which development team signs a device build when the project names none.
 * Xcode needs a team; given one, it picks the provisioning profile itself.
 * The team is the one whose development profile on this Mac lists the
 * device, still valid, with a signing certificate in the keychain: there is
 * usually exactly one. Reading profiles and the identity list needs no
 * unlocked keychain.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryCapture } from '../proc.js';

export interface DevelopmentProfile {
  name: string;
  team: string;
  /** Devices it lists (or `all` for an enterprise profile). */
  devices: string[] | 'all';
  expires: Date | null;
  /** get-task-allow: a development profile (debugging allowed). */
  development: boolean;
  /** SHA-1s of the certificates that may sign with it, as `security find-identity` prints them. */
  certificates: string[];
}

const PROFILE_DIRS = [path.join('Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'), path.join('Library', 'MobileDevice', 'Provisioning Profiles')];

function plistValue(xml: string, key: string, type: 'string' | 'date'): string | null {
  return new RegExp(`<key>${key}</key>\\s*<${type}>([^<]*)</${type}>`).exec(xml)?.[1]?.trim() ?? null;
}

function plistArray(xml: string, key: string): string | null {
  return new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml)?.[1] ?? null;
}

/** A provisioning profile's plist (as `security cms -D` prints it), or null when it is not one. */
export function parseProfile(xml: string): DevelopmentProfile | null {
  const team = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1]?.trim();
  if (!team) return null;
  const listed = plistArray(xml, 'ProvisionedDevices');
  const devices = /<key>ProvisionsAllDevices<\/key>\s*<true\s*\/>/.test(xml) ? 'all' : [...(listed ?? '').matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]!.trim());
  const expires = plistValue(xml, 'ExpirationDate', 'date');
  const certificates = [...(plistArray(xml, 'DeveloperCertificates') ?? '').matchAll(/<data>([^<]+)<\/data>/g)].map((m) =>
    createHash('sha1').update(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64')).digest('hex').toUpperCase(),
  );
  return {
    name: plistValue(xml, 'Name', 'string') ?? '',
    team,
    devices,
    expires: expires ? new Date(expires) : null,
    development: /<key>get-task-allow<\/key>\s*<true\s*\/>/.test(xml),
    certificates,
  };
}

/** The SHA-1s of the valid code signing identities, from `security find-identity -v -p codesigning`. */
export function parseIdentities(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"[^"]*"\s*(\(.*\))?\s*$/i.exec(line);
    // A revoked or expired certificate says so after its name.
    if (m && !m[2]) ids.add(m[1]!.toUpperCase());
  }
  return ids;
}

/** The teams that can sign a development build for `udid`, from the profiles and identities given. */
export function teamsFor(udid: string, profiles: DevelopmentProfile[], identities: Set<string>, now = new Date()): string[] {
  const id = udid.toUpperCase();
  const teams = new Set<string>();
  for (const p of profiles) {
    if (!p.development || (p.expires && p.expires <= now)) continue;
    if (p.devices !== 'all' && !p.devices.some((d) => d.toUpperCase() === id)) continue;
    if (!p.certificates.some((c) => identities.has(c))) continue;
    teams.add(p.team);
  }
  return [...teams].sort();
}

/** The development teams on this Mac that can sign for `udid` (usually one). */
export async function signingTeamsFor(udid: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const identities = parseIdentities((await tryCapture('security', ['find-identity', '-v', '-p', 'codesigning'], { env, timeoutMs: 30_000 })) ?? '');
  if (identities.size === 0) return [];
  const profiles: DevelopmentProfile[] = [];
  for (const dir of PROFILE_DIRS.map((d) => path.join(os.homedir(), d))) {
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.mobileprovision'));
    for (const file of files) {
      const xml = await tryCapture('security', ['cms', '-D', '-i', path.join(dir, file)], { env, timeoutMs: 15_000 });
      const profile = xml ? parseProfile(xml) : null;
      if (profile) profiles.push(profile);
    }
  }
  return teamsFor(udid, profiles, identities);
}
