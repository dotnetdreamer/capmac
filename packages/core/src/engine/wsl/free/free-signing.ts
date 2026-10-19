/**
 * Free Apple Account signing: makes the same result as setUpAutomaticSigning (a
 * certificate path and a development profile per target) but through a free Apple
 * ID, so the build and install side need no changes. It drops capabilities a free
 * account can't have, tells the developer what won't work, and warns about the
 * 7-day limit. Additive: nothing in the account is removed except a stale
 * development certificate this PC itself made.
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { log, throwIfAborted, type EngineContext } from '../../context.js';
import { UserError } from '../../errors.js';
import type { AutomaticSigningResult, SigningTarget } from '../apple-auto-signing.js';
import { APP_GROUPS, CAPABILITY_FOR_ENTITLEMENT, checkableEntitlements, NOT_CAPABILITIES, PORTAL_ONLY, signingNeeds } from '../apple-auto-signing.js';
import { appleProfileCovers, inspectAppleProfileContent, prepareAppleSigningDirectory } from '../apple-signing.js';
import { dpapi } from '../protect.js';
import { FREE_ACCOUNT_LIMITS, FREE_SUPPORTED_CAPABILITIES, lostFeaturesSummary, planFreeCapabilities } from './free-capabilities.js';
import type { FreeApple, FreeProvisionTarget, FreeTeam } from './free-apple.js';

/**
 * What to ask when Apple wants a two-factor code, by how it was sent. Apple pushes the code to the
 * iPhones the account is signed in on and, since 2026-10, won't text one to a non-Apple sign-in, so
 * the account must be on the iPhone. The prompt also says how to make a code there (Apple accepts
 * that one too), which works only for the iPhone's main Apple Account.
 */
export function freeCodeMessage(mode: string, again = false): string {
  const ask = mode === 'sms' ? 'Enter the code Apple texted to your phone'
    : 'Enter the code Apple shows on your iPhone. This Apple Account must be signed in on that iPhone. No code? If it’s the iPhone’s main Apple Account, open Settings, tap your name, then Sign-In & Security, then Get Verification Code';
  return again ? `That code didn’t work. ${ask}` : ask;
}

/** Picks the team to sign with: the only one, or the developer's choice (a free team is preferred). */
export async function chooseFreeTeam(teams: FreeTeam[], ctx: EngineContext): Promise<FreeTeam> {
  if (!teams.length) throw new UserError('This Apple Account has no team CapMac can use.', 'Sign in to developer.apple.com once to accept Apple’s agreement, then try again.');
  if (teams.length === 1) return teams[0]!;
  const preferred = teams.filter((team) => team.free);
  const items = (preferred.length ? preferred : teams).map((team) => ({ label: `${team.name} (${team.id})${team.free ? ' · free' : ' · paid'}`, value: team }));
  return ctx.prompter.choose<FreeTeam>({ message: 'Choose the Apple team to sign with:', items });
}

/** The free team folder, keyed by team id like the paid path (a free personal team id is 10 chars too). */
function freeTeamDirectory(root: string, teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new UserError('Apple returned an unexpected team ID.');
  return path.join(root, teamId);
}

/**
 * Sorts an app's entitlements for a free account: `blocked` can't be signed at all
 * (and setup stops with them named), `warn` are ones CapMac doesn't recognize
 * (the build is the final judge, so they're only mentioned), `verify` are the ones
 * the returned profile must actually grant.
 */
function classifyEntitlements(target: SigningTarget): { blocked: string[]; warn: string[]; verify: string[] } {
  const blocked = new Set<string>(); const warn = new Set<string>();
  for (const key of Object.keys(target.entitlements)) {
    if (NOT_CAPABILITIES.has(key)) continue;
    if (key === APP_GROUPS) continue; // free-supported; handled via the forwarded app-group identifiers
    if (PORTAL_ONLY[key]) { blocked.add(key); continue; } // iCloud, Apple Pay
    const capability = CAPABILITY_FOR_ENTITLEMENT[key];
    if (capability) { if (!FREE_SUPPORTED_CAPABILITIES.has(capability)) blocked.add(key); continue; }
    if (key.startsWith('com.apple.')) warn.add(key); // unknown to CapMac: don't presume it's paid-only
  }
  const checkable = checkableEntitlements(target.entitlements);
  const verify = Object.keys(checkable).filter((key) => !warn.has(key) && !blocked.has(key));
  return { blocked: [...blocked].sort(), warn: [...warn].sort(), verify };
}

export interface FreeSigningOptions {
  signal?: AbortSignal;
  connectedDevice?: { udid: string; name: string };
  /** The Signing root; defaults to CapMac's per-user folder. Tests point it at a temp dir. */
  directory?: string;
}

/**
 * Sets up development signing for the app and its extensions with a free Apple ID.
 * Shows the limits and what won't work, and asks before making anything.
 */
export async function setUpFreeSigning(runner: FreeApple, team: FreeTeam, targets: SigningTarget[], ctx: EngineContext, options: FreeSigningOptions = {}): Promise<AutomaticSigningResult> {
  const signal = options.signal;
  if (!targets.length) throw new UserError('No app was found to sign.');
  const root = await prepareAppleSigningDirectory(options.directory);
  const directory = freeTeamDirectory(root, team.id);
  await fs.mkdir(directory, { recursive: true });

  // What each target needs, split into what a free account can and can't do.
  const lost = new Set<string>();
  const warn = new Set<string>();
  const blocked = new Set<string>();
  const provisionTargets: FreeProvisionTarget[] = [];
  const verifyKeys = new Map<string, string[]>();
  for (const target of targets) {
    const need = signingNeeds(target);
    const plan = planFreeCapabilities(need.capabilities, need.portalOnly);
    const capabilities = [...plan.supported];
    if (need.appGroups.length) capabilities.push('APP_GROUPS');
    provisionTargets.push({ bundleIdentifier: target.bundleIdentifier, capabilities, ...(need.appGroups.length ? { appGroups: need.appGroups } : {}) });
    const summary = lostFeaturesSummary(plan);
    if (summary) lost.add(summary);
    const classified = classifyEntitlements(target);
    for (const key of classified.blocked) blocked.add(key);
    for (const key of classified.warn) warn.add(key);
    verifyKeys.set(target.bundleIdentifier, classified.verify);
  }

  // Entitlements a free account can't sign at all; the build would fail later, so stop now.
  if (blocked.size) {
    throw new UserError(
      `A free Apple Account can’t sign these entitlements: ${[...blocked].sort().join(', ')}.`,
      'Remove them from the app’s entitlements for a free build, or use a paid Apple Developer account. These features need the paid program.');
  }

  const changes = [
    'Make a free Apple development certificate for this PC',
    ...(options.connectedDevice ? [`Register the iPhone “${options.connectedDevice.name}”`] : []),
    `Add the App IDs ${targets.map((target) => target.bundleIdentifier).join(', ')}`,
    `Make 7-day development profiles for ${targets.map((target) => target.bundleIdentifier).join(', ')}`,
  ];
  const detail = [
    ...changes.map((change) => `• ${change}`),
    '',
    'With a free Apple Account:',
    ...FREE_ACCOUNT_LIMITS.map((limit) => `• ${limit}`),
    ...(lost.size ? ['', ...lost] : []),
  ].join('\n');
  const confirmed = await ctx.prompter.confirm({
    message: `Set up free iPhone signing in the Apple Account team “${team.name}”?`,
    detail, defaultYes: true, confirmLabel: 'Set up signing',
  });
  if (!confirmed) throw new UserError('Signing setup was skipped.', 'Run setup again when you are ready.');
  throwIfAborted(signal);

  const result = await runner.provision(team.id, provisionTargets, options.connectedDevice, directory);

  // Check every profile BEFORE replacing the saved identity, so a bad result never
  // strands the build with a new certificate and an unusable profile.
  const udid = options.connectedDevice?.udid.toLowerCase();
  for (const target of targets) {
    const content = result.profiles[target.bundleIdentifier];
    if (!content) throw new UserError(`Apple did not return a profile for ${target.bundleIdentifier}.`);
    const details = inspectAppleProfileContent(content);
    const want = verifyKeys.get(target.bundleIdentifier) ?? [];
    const entitlements = Object.fromEntries(Object.entries(checkableEntitlements(target.entitlements)).filter(([key]) => want.includes(key)));
    if (!appleProfileCovers(details, { bundleIdentifier: target.bundleIdentifier, entitlements })) {
      throw new UserError(`Apple’s profile for ${target.bundleIdentifier} is missing some of the app’s capabilities.`, 'Apple can take a minute to apply new capabilities. Run setup again.');
    }
    if (udid && details.deviceUdids && !details.deviceUdids.some((device) => device.toLowerCase() === udid)) {
      throw new UserError(`Apple’s profile for ${target.bundleIdentifier} doesn’t include this iPhone.`, 'Keep the iPhone plugged in, unlocked and trusted, then run setup again.');
    }
  }

  // Everything checks out: save the certificate, then the profiles the build reads.
  const certificateFile = await saveFreeCertificate(directory, result.p12, result.password, result.certificate);
  const profiles: Record<string, string> = {};
  for (const target of targets) {
    const file = path.join(directory, `${target.bundleIdentifier}.mobileprovision`);
    await fs.writeFile(file, Buffer.from(result.profiles[target.bundleIdentifier]!, 'base64'));
    profiles[target.bundleIdentifier] = file;
  }

  for (const note of result.notes) log(ctx, 'info', note);
  for (const key of warn) log(ctx, 'info', `CapMac doesn’t recognize the entitlement ${key}; if signing fails, remove it from the app.`);
  const summary = [...lost].join(' ');
  if (summary) log(ctx, 'info', summary);
  log(ctx, 'info', 'This free signing lasts 7 days. Run setup again to renew it.');
  const [app, ...extensions] = targets;
  return {
    certificate: certificateFile,
    profile: profiles[app!.bundleIdentifier]!,
    extensionProfiles: Object.fromEntries(extensions.map((target) => [target.bundleIdentifier, profiles[target.bundleIdentifier]!])),
  };
}

const passwordFile = (certificate: string) => `${certificate}.dpapi`;

/** Writes development.p12 + its DPAPI-protected password + development.json, the layout the build reads. */
async function saveFreeCertificate(directory: string, p12Base64: string, password: string, info: { serial: string; notAfter: string }): Promise<string> {
  if (!p12Base64) throw new UserError('CapMac did not receive a signing certificate from Apple.');
  const file = path.join(directory, 'development.p12');
  const temporary = `${file}.${process.pid}.new`;
  await fs.writeFile(temporary, Buffer.from(p12Base64, 'base64'));
  await fs.writeFile(passwordFile(temporary), (await dpapi('Protect', Buffer.from(password, 'utf8'))).toString('base64'));
  await fs.rename(passwordFile(temporary), passwordFile(file));
  await fs.rename(temporary, file);
  await fs.writeFile(path.join(directory, 'development.json'), JSON.stringify({ serialNumber: info.serial, expirationDate: info.notAfter, free: true }, null, 2) + '\n');
  if (!existsSync(file)) throw new UserError('CapMac could not save the signing certificate.');
  return file;
}
