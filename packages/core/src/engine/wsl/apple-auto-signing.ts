/**
 * Xcode-style automatic development signing with the signed-in Apple Account:
 * App IDs, capabilities, app groups, a development certificate and profiles.
 * Additive only: nothing in the account is revoked, deleted or turned off.
 */
import { createPrivateKey, createPublicKey, randomBytes, X509Certificate, type KeyObject } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as ExpoApple from '@expo/apple-utils';
import plist from 'plist';
import { log, throwIfAborted, type EngineContext } from '../context.js';
import { CancelledError, isCancelled, UserError } from '../errors.js';
import type { ProjectInfo } from '../project.js';
import type { AppleAccountSession, AppleRequestContext } from './apple-account.js';
import { appleProfileCovers, inspectAppleProfileContent, prepareAppleSigningDirectory } from './apple-signing.js';
import { appleWeb, AppleWebStopped, type AppleWeb } from './apple-web.js';
import { dpapi } from './protect.js';
import type { WslExecutor } from './toolchain.js';
import exporter from './pods-export.rb';

type Expo = typeof ExpoApple;

export interface SigningTarget {
  name: string;
  bundleIdentifier: string;
  extension: boolean;
  /** Build settings already expanded, e.g. $(APS_ENVIRONMENT) → development. */
  entitlements: Record<string, plist.PlistValue>;
}

export interface AutomaticSigningResult {
  certificate: string;
  profile: string;
  extensionProfiles: Record<string, string>;
}

/** Entitlements that only need their capability turned on for the App ID. */
export const CAPABILITY_FOR_ENTITLEMENT: Record<string, string> = {
  'aps-environment': 'PUSH_NOTIFICATIONS',
  'com.apple.developer.aps-environment': 'PUSH_NOTIFICATIONS',
  'com.apple.developer.applesignin': 'APPLE_ID_AUTH',
  'com.apple.developer.game-center': 'GAME_CENTER',
  'com.apple.developer.associated-domains': 'ASSOCIATED_DOMAINS',
  'com.apple.developer.healthkit': 'HEALTHKIT',
  'com.apple.developer.homekit': 'HOMEKIT',
  'com.apple.developer.networking.wifi-info': 'ACCESS_WIFI_INFORMATION',
  'com.apple.developer.nfc.readersession.formats': 'NFC_TAG_READING',
  'com.apple.developer.siri': 'SIRIKIT',
  'com.apple.developer.networking.multipath': 'MULTIPATH',
  'com.apple.developer.networking.HotspotConfiguration': 'HOT_SPOT',
  'com.apple.developer.networking.vpn.api': 'PERSONAL_VPN',
  'com.apple.developer.networking.networkextension': 'NETWORK_EXTENSIONS',
  'com.apple.developer.usernotifications.time-sensitive': 'USERNOTIFICATIONS_TIMESENSITIVE',
  'com.apple.developer.usernotifications.communication': 'USERNOTIFICATIONS_COMMUNICATION',
  'com.apple.developer.kernel.increased-memory-limit': 'INCREASED_MEMORY_LIMIT',
  'com.apple.developer.kernel.extended-virtual-addressing': 'EXTENDED_VIRTUAL_ADDRESSING',
  'com.apple.developer.devicecheck.appattest-environment': 'APP_ATTEST',
  'com.apple.developer.weatherkit': 'WEATHERKIT',
  'com.apple.developer.group-session': 'GROUP_ACTIVITIES',
  'com.apple.developer.authentication-services.autofill-credential-provider': 'AUTOFILL_CREDENTIAL_PROVIDER',
  'com.apple.developer.ClassKit-environment': 'CLASSKIT',
  'com.apple.developer.pass-type-identifiers': 'WALLET',
  'inter-app-audio': 'INTER_APP_AUDIO',
  'com.apple.external-accessory.wireless-configuration': 'WIRELESS_ACCESSORY_CONFIGURATION',
};
export const APP_GROUPS = 'com.apple.security.application-groups';
/** These need identifiers (containers, merchant IDs) that are made in the developer portal. */
export const PORTAL_ONLY: Record<string, string> = {
  'com.apple.developer.icloud-container-identifiers': 'iCloud',
  'com.apple.developer.icloud-services': 'iCloud',
  'com.apple.developer.ubiquity-container-identifiers': 'iCloud',
  'com.apple.developer.ubiquity-kvstore-identifier': 'iCloud',
  'com.apple.developer.in-app-payments': 'Apple Pay',
};
/** Signing fills these in itself; they are not App ID capabilities. */
export const NOT_CAPABILITIES = new Set(['application-identifier', 'com.apple.developer.team-identifier', 'get-task-allow', 'keychain-access-groups', 'beta-reports-active']);
const CAPABILITY_NAMES: Record<string, string> = {
  PUSH_NOTIFICATIONS: 'Push Notifications', APPLE_ID_AUTH: 'Sign in with Apple', GAME_CENTER: 'Game Center', ASSOCIATED_DOMAINS: 'Associated Domains', APP_GROUPS: 'App Groups',
};
const capabilityName = (type: string) => CAPABILITY_NAMES[type] ?? type.toLowerCase().replace(/_/g, ' ');

/** Reads app and extension targets with the same exporter the build uses. Read-only. */
const READ_TARGETS = `require 'json'
load ARGV.fetch(0)
request = JSON.parse($stdin.read)
graph = CapMacPods.export(request)
def capmac_resolve(value, settings)
  case value
  when Hash then value.each_with_object({}) { |(key, item), out| out[key] = capmac_resolve(item, settings) }
  when Array then value.map { |item| capmac_resolve(item, settings) }
  when String then CapMacPods.expand(value, settings)
  when true, false, Integer, Float then value
  else value.to_s
  end
end
targets = graph['targets'].select { |target| %w[application appExtension].include?(target['productType']) }.map do |target|
  settings = target['settings']
  file = settings['CODE_SIGN_ENTITLEMENTS'].to_s
  entitlements = file.empty? ? {} : capmac_resolve(Xcodeproj::Plist.read_from_path(File.expand_path(file, settings['SRCROOT'])), settings)
  { 'name' => target['name'], 'kind' => target['productType'], 'root' => target['id'] == graph['rootTargetId'],
    'bundleIdentifier' => settings['PRODUCT_BUNDLE_IDENTIFIER'].to_s, 'entitlements' => entitlements }
end
puts JSON.generate(targets)
`;

export async function readSigningTargets(project: ProjectInfo, executor: WslExecutor, options: { configuration?: string; ruby?: string; scheme?: string; signal?: AbortSignal } = {}): Promise<SigningTarget[]> {
  throwIfAborted(options.signal);
  const directory = path.join(project.capDir, '.capmac', 'wsl', 'signing');
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([fs.writeFile(path.join(directory, 'pods-export.rb'), exporter), fs.writeFile(path.join(directory, 'read-targets.rb'), READ_TARGETS)]);
  const [script, library, root, ios] = await Promise.all([
    executor.path(path.join(directory, 'read-targets.rb'), options.signal), executor.path(path.join(directory, 'pods-export.rb'), options.signal),
    executor.path(project.syncRoot, options.signal), executor.path(path.resolve(project.capDir, project.iosDir), options.signal),
  ]);
  const result = await executor.run([options.ruby ?? 'ruby', '-rxcodeproj', script, library], {
    signal: options.signal, allowFailure: true, timeoutMs: 120_000,
    // Pods projects hold no app targets; skipping them keeps this independent of `pod install`.
    stdin: JSON.stringify({ projectRoot: root, projectDirectory: ios, swiftPackages: true, configuration: options.configuration ?? 'Debug', sdkPath: '/capmac-signing', scheme: options.scheme ?? project.scheme }),
  });
  if (result.code !== 0) throw new UserError('Could not read the app’s signing settings from the Xcode project.', 'Check that the iOS project opens in Xcode, then try again.', result.stderr.trim().split(/\r?\n/).slice(-8));
  let parsed: { name: string; kind: string; root: boolean; bundleIdentifier: string; entitlements: Record<string, plist.PlistValue> }[];
  try { parsed = JSON.parse(result.stdout); } catch { throw new UserError('The Xcode project reader returned invalid output.'); }
  const app = parsed.find((target) => target.root && target.kind === 'application');
  if (!app?.bundleIdentifier || app.bundleIdentifier.includes('$(')) throw new UserError('Could not find the app’s bundle identifier in the Xcode project.');
  // Apple only accepts extensions whose identifier extends the app's; the build embeds the same ones.
  const extensions = parsed.filter((target) => target.kind === 'appExtension' && target.bundleIdentifier.startsWith(app.bundleIdentifier + '.'));
  return [app, ...extensions].map((target) => ({ name: target.name, bundleIdentifier: target.bundleIdentifier, extension: target.kind === 'appExtension', entitlements: target.entitlements ?? {} }));
}

/** Capabilities, app groups and portal-only features each target needs. */
export function signingNeeds(target: SigningTarget): { capabilities: string[]; appGroups: string[]; portalOnly: string[]; unknown: string[] } {
  const capabilities = new Set<string>(); const portalOnly = new Set<string>(); const unknown: string[] = [];
  for (const key of Object.keys(target.entitlements)) {
    if (NOT_CAPABILITIES.has(key) || key === APP_GROUPS) continue;
    if (CAPABILITY_FOR_ENTITLEMENT[key]) capabilities.add(CAPABILITY_FOR_ENTITLEMENT[key]);
    else if (PORTAL_ONLY[key]) portalOnly.add(PORTAL_ONLY[key]);
    else if (key.startsWith('com.apple.')) unknown.push(key);
  }
  const groups = target.entitlements[APP_GROUPS];
  const appGroups = Array.isArray(groups) ? groups.filter((group): group is string => typeof group === 'string') : [];
  return { capabilities: [...capabilities].sort(), appGroups, portalOnly: [...portalOnly].sort(), unknown };
}

/** Entitlement values with unresolved variables, such as $(AppIdentifierPrefix), are filled in at signing time. */
export function checkableEntitlements(entitlements: Record<string, plist.PlistValue>): Record<string, plist.PlistValue> {
  return Object.fromEntries(Object.entries(entitlements).filter(([key, value]) => !NOT_CAPABILITIES.has(key) && !JSON.stringify(value).includes('$(')));
}

/** Apple's own error text helps here and carries no session data; keep it short. */
function appleDetail(error: unknown): string[] {
  if (error instanceof UserError) return [error.message, ...(error.details ?? [])];
  const message = String((error as { message?: unknown })?.message ?? '').replace(/[\0-\x1f\x7f]/g, ' ').trim();
  return message ? [message.slice(0, 300)] : [];
}
/** Apple answers 421 when it makes something only for its website (certificates, profiles, devices). */
const WEBSITE_ONLY = 'Apple makes this only on its website for your account. Run setup again and choose “Let CapMac do it”: CapMac signs in on Apple’s website and does it there.';

async function step<T>(label: string, action: () => Promise<T>, hint?: string): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof CancelledError) throw error;
    const details = appleDetail(error);
    throw new UserError(`Apple could not ${label}.`, hint ?? (details.some((line) => /\bHTTP 421\b/.test(line)) ? WEBSITE_ONLY : 'Check the account at developer.apple.com, then run capmac wsl setup again.'), details);
  }
}

// ---------------------------------------------------------------------------
// Windows data protection keeps the certificate password usable only by this Windows user.

const passwordFile = (certificate: string) => `${certificate}.dpapi`;

/** The password of a certificate CapMac made, or undefined for a certificate the developer supplied. */
export async function savedCertificatePassword(certificate: string): Promise<string | undefined> {
  const file = passwordFile(certificate);
  if (!existsSync(file)) return undefined;
  return (await dpapi('Unprotect', Buffer.from((await fs.readFile(file, 'utf8')).trim(), 'base64'))).toString('utf8');
}

// ---------------------------------------------------------------------------

interface Inventory {
  bundles: Map<string, ExpoApple.BundleId>;
  capabilities: Map<string, Set<string>>;
  devices: ExpoApple.Device[];
  certificate?: { id: string; file: string };
}
interface SavedCertificate { id: string; serialNumber?: string; expirationDate?: string }

function teamDirectory(root: string, teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new UserError('Apple returned an unexpected team ID.');
  return path.join(root, teamId);
}

async function readInventory(expo: Expo, context: AppleRequestContext, targets: SigningTarget[], directory: string): Promise<Inventory> {
  const bundles = new Map<string, ExpoApple.BundleId>(); const capabilities = new Map<string, Set<string>>();
  for (const target of targets) {
    const bundle = await step(`look up the App ID ${target.bundleIdentifier}`, () => expo.BundleId.findAsync(context, { identifier: target.bundleIdentifier }));
    if (!bundle || bundle.attributes.identifier !== target.bundleIdentifier) continue;
    bundles.set(target.bundleIdentifier, bundle);
    const current = await step(`read the capabilities of ${target.bundleIdentifier}`, () => bundle.getBundleIdCapabilitiesAsync());
    capabilities.set(target.bundleIdentifier, new Set(current.map((item) => String(item.attributes.capabilityType ?? item.id.split('_').slice(1).join('_')))));
  }
  const devices = (await step('list the team’s registered devices', () => expo.Device.getAllIOSProfileDevicesAsync(context)))
    .filter((device) => device.attributes.status === 'ENABLED' && ['IPHONE', 'IPAD', 'IPOD'].includes(String(device.attributes.deviceClass)));
  let certificate: Inventory['certificate'];
  const file = path.join(directory, 'development.p12');
  const saved = await fs.readFile(path.join(directory, 'development.json'), 'utf8').then((text) => JSON.parse(text) as SavedCertificate, () => undefined);
  if (saved?.id && existsSync(file) && existsSync(passwordFile(file))) {
    const current = await step('list development certificates', () => expo.Certificate.getAsync(context, { query: { filter: { certificateType: [expo.CertificateType.DEVELOPMENT, expo.CertificateType.IOS_DEVELOPMENT] } } }));
    const match = current.find((item) => item.id === saved.id);
    // Reuse only while Apple still lists it with more than a week left.
    if (match && new Date(String(match.attributes.expirationDate)).getTime() > Date.now() + 7 * 86_400_000) certificate = { id: match.id, file };
  }
  return { bundles, capabilities, devices, certificate };
}

/**
 * Sets up development signing for the app and its extensions, like Xcode's
 * "Automatically manage signing". Shows the changes and asks before making any.
 */
export async function setUpAutomaticSigning(session: AppleAccountSession, targets: SigningTarget[], ctx: EngineContext, options: {
  signal?: AbortSignal; connectedDevices?: { udid: string; name: string }[]; directory?: string;
  /** CapMac's WSL: makes a certificate request when Apple won't make the certificate itself. */
  executor?: WslExecutor;
  /** Apple's website, which makes that certificate when the API won't (tests pass their own). */
  web?: AppleWeb;
} = {}): Promise<AutomaticSigningResult> {
  const signal = options.signal;
  const root = await prepareAppleSigningDirectory(options.directory);
  const directory = teamDirectory(root, session.team.id);
  await fs.mkdir(directory, { recursive: true });
  const needs = new Map(targets.map((target) => [target.bundleIdentifier, signingNeeds(target)]));
  const portal = [...new Set([...needs.values()].flatMap((need) => need.portalOnly))];
  if (portal.length) throw new UserError(`This app uses ${portal.join(' and ')}, which CapMac can’t set up yet.`, 'Turn it on for the App ID at developer.apple.com, make a development profile there, and pass it with --profile.');

  const inventory = await session.connect((expo, context) => readInventory(expo, context, targets, directory), signal, 'Apple signing lookup');
  const registered = new Set(inventory.devices.map((device) => device.attributes.udid.toUpperCase()));
  const newDevices = (options.connectedDevices ?? []).filter((device) => !registered.has(device.udid.toUpperCase()));
  if (!inventory.devices.length && !newDevices.length) throw new UserError('Your Apple team has no iPhone registered yet.', 'Plug in your iPhone, unlock it and tap Trust, then run capmac wsl setup again.');

  // Show every account change before making it.
  const changes: string[] = [];
  if (!inventory.certificate) changes.push('Make an Apple Development certificate for this PC');
  for (const device of newDevices) changes.push(`Register the iPhone “${device.name}”`);
  for (const target of targets) {
    if (!inventory.bundles.has(target.bundleIdentifier)) changes.push(`Add the App ID ${target.bundleIdentifier}`);
    const have = inventory.capabilities.get(target.bundleIdentifier) ?? new Set<string>();
    const missing = needs.get(target.bundleIdentifier)!.capabilities.filter((type) => !have.has(type));
    if (missing.length) changes.push(`Turn on ${missing.map(capabilityName).join(', ')} for ${target.bundleIdentifier}`);
  }
  const groups = [...new Set([...needs.values()].flatMap((need) => need.appGroups))];
  if (groups.length) changes.push(`Make sure the app group ${groups.join(', ')} is on for ${targets.filter((target) => needs.get(target.bundleIdentifier)!.appGroups.length).map((target) => target.bundleIdentifier).join(' and ')}`);
  changes.push(`Make development profiles for ${targets.map((target) => target.bundleIdentifier).join(' and ')}`);
  const confirmed = await ctx.prompter.confirm({
    message: `Set up iPhone signing in the Apple team “${session.team.name}”?`,
    detail: changes.map((change) => `• ${change}`).join('\n') + '\nNothing in your account is removed. Release profiles made before this need to be made again to include new capabilities.',
    defaultYes: true, confirmLabel: 'Set up signing',
  });
  if (!confirmed) throw new UserError('Signing setup was skipped.', 'Run capmac wsl setup again when you are ready, or pass your own files with --certificate and --profile.');
  throwIfAborted(signal);

  // 1. App IDs and plain capabilities. Apple adds new App IDs only on its website for some accounts
  // too (421 to CapMac's own client): signed in there, CapMac adds them there, then reads them back.
  const web = options.web ?? appleWeb;
  const bundleName = (identifier: string) => `CapMac ${identifier}`.replace(/[^A-Za-z0-9 ]/g, ' ');
  const madeOnWebsite = new Set<string>();
  const missingBundles = targets.filter((target) => !inventory.bundles.has(target.bundleIdentifier));
  if (missingBundles.length && session.via === 'website' && options.executor) {
    // When the website can't be opened or won't add one, CapMac's own client below tries, as before.
    const site = await web.open(session.team, ctx, signal).catch((error: unknown) => {
      if (isCancelled(error) || error instanceof AppleWebStopped || signal?.aborted) throw error;
      log(ctx, 'debug', `Apple’s website didn’t open for the App IDs: ${(error as Error).message}`);
      return undefined;
    });
    if (site) {
      try {
        for (const target of missingBundles) {
          try {
            await site.bundleId({ name: bundleName(target.bundleIdentifier), identifier: target.bundleIdentifier });
            madeOnWebsite.add(target.bundleIdentifier);
          } catch (error) {
            if (isCancelled(error) || error instanceof AppleWebStopped || signal?.aborted) throw error;
            log(ctx, 'debug', `Apple’s website didn’t add the App ID ${target.bundleIdentifier}: ${(error as Error).message}`);
          }
        }
      } finally {
        await site.close();
      }
    }
  }
  await session.connect(async (expo, context) => {
    for (const target of targets) {
      let bundle = inventory.bundles.get(target.bundleIdentifier);
      if (!bundle && madeOnWebsite.has(target.bundleIdentifier)) {
        bundle = await step(`read the App ID ${target.bundleIdentifier}`, async () => {
          // Apple can take a moment to list what its website just made.
          for (let attempt = 0; ; attempt++) {
            const made = await expo.BundleId.findAsync(context, { identifier: target.bundleIdentifier });
            if (made) return made;
            if (attempt >= 5) throw new UserError(`Apple added the App ID ${target.bundleIdentifier} but doesn’t list it yet.`, 'Run setup again in a minute.');
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        });
        inventory.bundles.set(target.bundleIdentifier, bundle);
      }
      if (!bundle) {
        bundle = await step(`add the App ID ${target.bundleIdentifier}`, () => expo.BundleId.createAsync(context, { name: bundleName(target.bundleIdentifier), identifier: target.bundleIdentifier, platform: expo.BundleIdPlatform.IOS }));
        inventory.bundles.set(target.bundleIdentifier, bundle);
      }
      const have = inventory.capabilities.get(target.bundleIdentifier) ?? new Set<string>();
      for (const type of needs.get(target.bundleIdentifier)!.capabilities.filter((item) => !have.has(item))) {
        await step(`turn on ${capabilityName(type)} for ${target.bundleIdentifier}`, () => bundle!.updateBundleIdCapabilityAsync({ capabilityType: type as ExpoApple.CapabilityType, option: expo.CapabilityTypeOption.ON as never }));
      }
    }
  }, signal, 'Apple App ID setup');

  // 2. App groups, through the reviewed additive planner.
  const groupRequirements = targets.map((target) => ({ bundleIdentifier: target.bundleIdentifier, appGroups: needs.get(target.bundleIdentifier)!.appGroups })).filter((item) => item.appGroups.length);
  if (groupRequirements.length) {
    const plan = await session.planAppGroupAssignments(groupRequirements, signal);
    if (plan.groupsToCreate.length || plan.assignments.some((assignment) => assignment.needsUpdate)) await session.applyAppGroupAssignments(plan, signal);
  }

  // 3. Certificate, devices and profiles. Apple makes devices and profiles only on its website
  // for some accounts (421 to CapMac's own client): signed in there, CapMac makes them there.
  const certificate = inventory.certificate ?? await createDevelopmentCertificate(session, directory, signal, options.executor ? { executor: options.executor, ctx, web } : undefined);
  const website = session.via === 'website' && options.executor ? await web.open(session.team, ctx, signal) : undefined;
  const again = website ? 'Run setup again. CapMac keeps what it already made.' : undefined;
  try {
    return await session.connect(async (expo, context) => {
      const deviceIds = inventory.devices.map((device) => device.id);
      for (const device of newDevices) {
        const name = device.name.replace(/[^\p{L}\p{N} '’._-]/gu, ' ').trim().slice(0, 50) || 'iPhone';
        deviceIds.push(await step(`register the iPhone “${name}”`, async () => website
          ? website.device({ name, udid: device.udid })
          : (await expo.Device.createAsync(context, { name, udid: device.udid, platform: expo.BundleIdPlatform.IOS })).id, again));
      }
      const profiles: Record<string, string> = {};
      for (const target of targets) {
        const bundle = inventory.bundles.get(target.bundleIdentifier)!;
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
        const name = `CapMac ${target.bundleIdentifier} ${stamp}`;
        const content = await step(`make a development profile for ${target.bundleIdentifier}`, async () => website
          ? (await website.profile({ name, bundleId: bundle.id, certificateId: certificate.id, deviceIds })).content
          : (await expo.Profile.createAsync(context, { bundleId: bundle.id, certificates: [certificate.id], devices: deviceIds, name, profileType: expo.ProfileType.IOS_APP_DEVELOPMENT })).attributes.profileContent, again);
        if (typeof content !== 'string') throw new UserError(`Apple did not send the profile for ${target.bundleIdentifier}.`);
        if (!appleProfileCovers(inspectAppleProfileContent(content), { bundleIdentifier: target.bundleIdentifier, entitlements: checkableEntitlements(target.entitlements) })) {
          throw new UserError(`Apple’s profile for ${target.bundleIdentifier} is missing some of the app’s capabilities.`, 'Apple can take a minute to apply new capabilities. Run capmac wsl setup again.');
        }
        const file = path.join(directory, `${target.bundleIdentifier}.mobileprovision`);
        await fs.writeFile(file, Buffer.from(content, 'base64'));
        profiles[target.bundleIdentifier] = file;
      }
      const [app, ...extensions] = targets;
      return { certificate: certificate.file, profile: profiles[app!.bundleIdentifier]!, extensionProfiles: Object.fromEntries(extensions.map((target) => [target.bundleIdentifier, profiles[target.bundleIdentifier]!])) };
    }, signal, 'Apple signing setup');
  } finally {
    await website?.close();
  }
}

/**
 * Makes the development certificate this PC signs with, and keeps it with its
 * password protected for this Windows user. When Apple answers 421
 * ("misdirected": nothing was made) on its usual portal host, the same request
 * goes to apple-utils' other portal host, then as the older iOS App Development
 * type, which signs development apps the same way. Every answer is kept, and
 * when Apple won't make one at all, the developer makes it on Apple's website.
 */
async function createDevelopmentCertificate(session: AppleAccountSession, directory: string, signal?: AbortSignal, browser?: WebsiteHelpers): Promise<{ id: string; file: string }> {
  // A request made earlier waits for its certificate from Apple's website: finish that one.
  if (browser && existsSync(path.join(directory, PENDING.request))) return browserCertificate(session, directory, browser, signal);
  const attempts: Array<{ otherPortalHost: boolean; type: 'DEVELOPMENT' | 'IOS_DEVELOPMENT'; note?: string }> = [
    { otherPortalHost: false, type: 'DEVELOPMENT' },
    { otherPortalHost: true, type: 'DEVELOPMENT', note: 'Then on the other portal host:' },
    { otherPortalHost: false, type: 'IOS_DEVELOPMENT', note: 'Then as an iOS App Development certificate:' },
  ];
  const answers: string[] = [];
  let created: Awaited<ReturnType<Expo['createCertificateAndP12Async']>> | undefined;
  for (const [index, attempt] of attempts.entries()) {
    try {
      created = await session.connect((expo, context) => step('make an Apple Development certificate', () => expo.createCertificateAndP12Async(context, { certificateType: expo.CertificateType[attempt.type] })),
        signal, 'Apple certificate setup', { otherPortalHost: attempt.otherPortalHost });
      break;
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      if (attempt.note) answers.push(attempt.note);
      answers.push(...(error.details ?? []));
      const misdirected = (error.details ?? []).some((line) => /\bHTTP 421\b/.test(line));
      if (misdirected && index < attempts.length - 1) continue;
      // Apple won't make it for this sign-in at all: the developer makes it on Apple's website.
      if (misdirected && browser) return browserCertificate(session, directory, browser, signal);
      // The limit hint only when Apple says the team has too many certificates.
      const limit = answers.some((line) => /maximum|already have|limit/i.test(line));
      throw new UserError(error.message, limit
        ? 'Apple allows only a few development certificates per person. Revoke one you no longer use at developer.apple.com/account/resources/certificates, then run capmac wsl setup again.'
        : 'Check the account at developer.apple.com, then run capmac wsl setup again. To sign with your own files instead, pass --certificate and --profile.', answers);
    }
  }
  if (!created) throw new UserError('Apple could not make an Apple Development certificate.', undefined, answers);
  return saveCertificate(directory, Buffer.from(created.certificateP12, 'base64'), created.password, { id: created.certificate.id, serialNumber: created.certificate.attributes.serialNumber, expirationDate: created.certificate.attributes.expirationDate });
}

/** Keeps the certificate and its password, protected for this Windows user, where builds find them. */
async function saveCertificate(directory: string, p12: Buffer, password: string, saved: SavedCertificate): Promise<{ id: string; file: string }> {
  const file = path.join(directory, 'development.p12');
  const temporary = `${file}.${process.pid}.new`;
  await fs.writeFile(temporary, p12);
  await fs.writeFile(passwordFile(temporary), (await dpapi('Protect', Buffer.from(password, 'utf8'))).toString('base64'));
  await fs.rename(passwordFile(temporary), passwordFile(file));
  await fs.rename(temporary, file);
  await fs.writeFile(path.join(directory, 'development.json'), JSON.stringify(saved, null, 2) + '\n');
  return { id: saved.id, file };
}

// ---------------------------------------------------------------------------
// The certificate from Apple's website. Some Apple ID sign-ins can't make one
// (Apple answers 421) while everything else in signing works. CapMac makes the
// private key and a certificate request on this PC; then either CapMac uploads
// the request on Apple's website in a browser it drives, or the developer does
// and downloads the certificate. The key never leaves this PC, and is kept
// protected for this Windows user meanwhile.

const PENDING = { key: 'pending-key.dpapi', request: 'pending.certSigningRequest' } as const;
const CERTIFICATES_PAGE = 'https://developer.apple.com/account/resources/certificates/add';

interface WebsiteHelpers { executor: WslExecutor; ctx: EngineContext; web: AppleWeb }
/** A certificate (DER, or PEM from a file), with Apple's id for it when known. */
interface FoundCertificate { certificate: Buffer; id?: string }
type Way = 'web' | 'web-fresh' | 'manual';

const uploadFile = (teamId: string) => path.join(os.homedir(), 'Downloads', `CapMac-${teamId}.certSigningRequest`);
const waitingForCertificate = () => new UserError('Signing is waiting for your certificate from Apple’s website.', 'Run setup again when you are ready. CapMac keeps its request, so the certificate you make still fits.');

/** Tells the certificate made from CapMac's request by its public key. */
function madeFrom(key: string): (certificate: Buffer) => boolean {
  let mine: KeyObject;
  try { mine = createPrivateKey(key); } catch { return () => false; }
  return (certificate) => {
    try { return new X509Certificate(certificate).publicKey.equals(createPublicKey(mine)); } catch { return false; }
  };
}

/** A dismissed question leaves the request waiting; Stop stays a cancel. */
async function answer<T>(signal: AbortSignal | undefined, question: () => Promise<T>): Promise<T> {
  try { return await question(); }
  catch (error) { throw error instanceof CancelledError && !signal?.aborted ? waitingForCertificate() : error; }
}

async function readCertificate(file: string): Promise<Buffer> {
  return fs.readFile(file).catch(() => { throw new UserError(`CapMac can’t read ${file}.`, 'Download the certificate from Apple’s website again.'); });
}

/** A certificate Apple already made from CapMac's request: on its website, maybe in an earlier setup. */
async function listedCertificate(session: AppleAccountSession, ours: (certificate: Buffer) => boolean, signal?: AbortSignal): Promise<FoundCertificate | undefined> {
  try {
    const listed = await session.connect((expo, context) => expo.Certificate.getAsync(context, { query: { filter: { certificateType: [expo.CertificateType.DEVELOPMENT, expo.CertificateType.IOS_DEVELOPMENT] } } }), signal, 'Apple certificate lookup');
    for (const item of listed) {
      const content = item.attributes.certificateContent;
      if (typeof content !== 'string') continue;
      const certificate = Buffer.from(content, 'base64');
      if (ours(certificate)) return { certificate, id: item.id };
    }
  } catch (error) {
    // Only a shortcut: setup goes on without it.
    if (error instanceof CancelledError || signal?.aborted) throw error;
  }
  return undefined;
}

/**
 * Signed in on Apple's website (the developer let CapMac do it), CapMac makes it
 * there too, offering another try when it can't; signed in here with a password,
 * the developer makes it on the website themselves.
 */
async function websiteCertificate(session: AppleAccountSession, requestFile: string, requestedAt: number, ours: (certificate: Buffer) => boolean, { ctx, web }: WebsiteHelpers, signal?: AbortSignal): Promise<FoundCertificate> {
  const browser = session.via === 'website' ? await web.findBrowser().catch(() => undefined) : undefined;
  let way: Way = browser ? 'web' : 'manual';
  for (;;) {
    throwIfAborted(signal);
    if (way === 'manual' || !browser) return manualCertificate(session, requestFile, requestedAt, ours, ctx, signal);
    try {
      return await web.makeCertificate({ csr: await fs.readFile(requestFile, 'utf8'), csrFile: requestFile, team: session.team, ours, fresh: way === 'web-fresh' }, ctx, signal, { browser });
    } catch (error) {
      if (!(error instanceof UserError) || error instanceof AppleWebStopped || signal?.aborted) throw error;
      way = await answer(signal, () => ctx.prompter.choose<Way>({
        message: 'CapMac couldn’t make the certificate on Apple’s website',
        // One line each, without closing periods, like every question's text.
        detail: [error.message, error.hint, ...error.details ?? []].filter(Boolean).map((line) => line!.replace(/(?<!\.)\.$/, '')).join('\n'),
        items: [
          { label: 'Try again', value: 'web' },
          { label: 'Try again with a fresh sign-in', value: 'web-fresh', hint: 'Forgets the saved sign-in, then you sign in to Apple again' },
          { label: 'Do it myself', value: 'manual', hint: 'Upload a file CapMac saves on Apple’s website, then download the certificate' },
        ],
      }));
    }
  }
}

/** The developer uploads CapMac's request on Apple's website and downloads the certificate. */
async function manualCertificate(session: AppleAccountSession, requestFile: string, requestedAt: number, ours: (certificate: Buffer) => boolean, ctx: EngineContext, signal?: AbortSignal): Promise<FoundCertificate> {
  const upload = uploadFile(session.team.id);
  await fs.mkdir(path.dirname(upload), { recursive: true });
  await fs.copyFile(requestFile, upload);
  throwIfAborted(signal);
  const ready = await ctx.prompter.confirm({
    message: 'Make your certificate on Apple’s website',
    detail: [
      'Apple doesn’t let CapMac make the certificate for this sign-in. It takes a minute on Apple’s website:',
      `1. Open ${CERTIFICATES_PAGE.replace('https://', '')} and sign in`,
      '2. Choose Apple Development, then Continue',
      `3. Choose the file CapMac saved: ${upload}`,
      '4. Continue, then Download. Keep the certificate in your Downloads folder',
      'Your private key stays on this PC.',
    ].join('\n'),
    confirmLabel: 'I downloaded it',
    link: { label: 'Open Apple’s website', url: CERTIFICATES_PAGE },
    defaultYes: true,
  });
  if (!ready) throw waitingForCertificate();
  const downloaded = await downloadedCertificate(requestedAt);
  if (downloaded) return { certificate: await readCertificate(downloaded) };
  // Made on the website but saved somewhere else: Apple lists it.
  const listed = await listedCertificate(session, ours, signal);
  if (listed) return listed;
  const typed = (await ctx.prompter.text({ message: 'Where is the certificate you downloaded (.cer)?', placeholder: path.join(path.dirname(upload), 'development.cer') })).trim().replace(/^"|"$/g, '');
  return { certificate: await readCertificate(typed) };
}

const MAKE_REQUEST = `import json, os, subprocess, tempfile
with tempfile.TemporaryDirectory() as work:
    key, request = os.path.join(work, 'key.pem'), os.path.join(work, 'request.csr')
    subprocess.run(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', request, '-subj', '/CN=CapMac Development'], check=True, capture_output=True)
    print(json.dumps({'key': open(key).read(), 'request': open(request).read()}))
`;

const MAKE_P12 = `import base64, json, os, subprocess, sys, tempfile
given = json.load(sys.stdin)
def openssl(*args, env=None):
    return subprocess.run(['openssl', *args], check=True, capture_output=True, text=True, env=env).stdout.strip()
with tempfile.TemporaryDirectory() as work:
    key, cer, pem, p12 = (os.path.join(work, name) for name in ('key.pem', 'cert.cer', 'cert.pem', 'out.p12'))
    open(key, 'w').write(given['key'])
    open(cer, 'wb').write(base64.b64decode(given['certificate']))
    try:
        openssl('x509', '-inform', 'DER', '-in', cer, '-out', pem)
    except subprocess.CalledProcessError:
        openssl('x509', '-in', cer, '-out', pem)
    out = {
        'matches': openssl('x509', '-in', pem, '-noout', '-modulus') == openssl('rsa', '-in', key, '-noout', '-modulus'),
        'serial': openssl('x509', '-in', pem, '-noout', '-serial').split('=', 1)[1],
        'notAfter': openssl('x509', '-in', pem, '-noout', '-enddate', '-dateopt', 'iso_8601').split('=', 1)[1],
        'subject': openssl('x509', '-in', pem, '-noout', '-subject', '-nameopt', 'RFC2253').split('=', 1)[1],
    }
    if out['matches']:
        openssl('pkcs12', '-export', '-inkey', key, '-in', pem, '-name', 'CapMac Development', '-out', p12, '-passout', 'env:CAPMAC_P12_PASSWORD', env=dict(os.environ, CAPMAC_P12_PASSWORD=given['password']))
        out['p12'] = base64.b64encode(open(p12, 'rb').read()).decode()
    print(json.dumps(out))
`;

const serialOf = (value: string) => value.replace(/^0+/, '').toUpperCase();

/** The newest .cer in Downloads since the request was made (Apple names it development.cer). */
async function downloadedCertificate(since: number): Promise<string | undefined> {
  const downloads = path.join(os.homedir(), 'Downloads');
  const names = await fs.readdir(downloads).catch(() => [] as string[]);
  const found = await Promise.all(names.filter((name) => /\.cer$/i.test(name)).map(async (name) => {
    const info = await fs.stat(path.join(downloads, name)).catch(() => undefined);
    return info?.isFile() && info.mtimeMs >= since - 60_000 ? { file: path.join(downloads, name), modified: info.mtimeMs } : undefined;
  }));
  return found.filter((item) => item !== undefined).sort((a, b) => b.modified - a.modified)[0]?.file;
}

async function browserCertificate(session: AppleAccountSession, directory: string, helpers: WebsiteHelpers, signal?: AbortSignal): Promise<{ id: string; file: string }> {
  const { executor } = helpers;
  const keyFile = path.join(directory, PENDING.key);
  const requestFile = path.join(directory, PENDING.request);
  // 1. The key and request, once: a request already uploaded must keep its key.
  if (!existsSync(keyFile) || !existsSync(requestFile)) {
    const made = await executor.run(['python3', '-c', MAKE_REQUEST], { signal, allowFailure: true, timeoutMs: 60_000 });
    let pair: { key: string; request: string };
    try { pair = JSON.parse(made.stdout); } catch { throw new UserError('CapMac could not make a certificate request.', 'Check that OpenSSL works in the CapMac WSL environment (capmac wsl doctor).'); }
    await fs.writeFile(keyFile, (await dpapi('Protect', Buffer.from(pair.key, 'utf8'))).toString('base64'));
    await fs.writeFile(requestFile, pair.request);
  }
  const requestedAt = (await fs.stat(requestFile)).mtimeMs;
  const key = (await dpapi('Unprotect', Buffer.from((await fs.readFile(keyFile, 'utf8')).trim(), 'base64'))).toString('utf8');
  const ours = madeFrom(key);
  // 2. The certificate: downloaded already, made already (Apple lists it), or made now on Apple's website.
  const downloaded = await downloadedCertificate(requestedAt);
  const found = (downloaded ? { certificate: await readCertificate(downloaded) } : await listedCertificate(session, ours, signal))
    ?? await websiteCertificate(session, requestFile, requestedAt, ours, helpers, signal);
  // 3. It must be the certificate for this key, from this team; then it becomes the .p12 builds use.
  const password = randomBytes(18).toString('base64url');
  const built = await executor.run(['python3', '-c', MAKE_P12], { signal, allowFailure: true, timeoutMs: 60_000, stdin: JSON.stringify({ key, certificate: found.certificate.toString('base64'), password }) });
  let result: { matches: boolean; serial: string; notAfter: string; subject: string; p12?: string };
  try { result = JSON.parse(built.stdout); } catch { throw new UserError('That file isn’t a certificate CapMac can read.', 'Download the Apple Development certificate (.cer) from Apple’s website again.'); }
  if (!result.matches || !result.p12) throw new UserError('That certificate was made from another request.', `Upload ${uploadFile(session.team.id)} on Apple’s website and download the certificate it makes.`);
  if (!result.subject.includes(`OU=${session.team.id}`)) throw new UserError(`That certificate belongs to another Apple team, not “${session.team.name}”.`, 'Switch to this team on Apple’s website, then make the certificate again.');
  // 4. Apple's id for it, which the profiles name.
  const serial = serialOf(result.serial);
  let id = found.id;
  for (let attempt = 0; attempt < 3 && !id; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
    const listed = await session.connect((expo, context) => step('list development certificates', () => expo.Certificate.getAsync(context, { query: { filter: { certificateType: [expo.CertificateType.DEVELOPMENT, expo.CertificateType.IOS_DEVELOPMENT] } } })), signal, 'Apple certificate lookup');
    id = listed.find((item) => serialOf(String(item.attributes.serialNumber ?? '')) === serial)?.id;
  }
  if (!id) throw new UserError('Apple doesn’t list that certificate for this team.', 'Check it at developer.apple.com/account/resources/certificates, then run setup again.');
  const saved = await saveCertificate(directory, Buffer.from(result.p12, 'base64'), password, { id, serialNumber: serial, expirationDate: new Date(result.notAfter.replace(' ', 'T')).toISOString() });
  await Promise.all([fs.rm(keyFile, { force: true }), fs.rm(requestFile, { force: true }), fs.rm(uploadFile(session.team.id), { force: true })]);
  return saved;
}
