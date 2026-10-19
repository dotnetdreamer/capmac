/**
 * What a free Apple Account (no paid Apple Developer Program membership) can and
 * cannot sign on a device, and how CapMac reports the difference. A free account
 * can install an app for 7 days on up to 3 devices, with a small set of
 * capabilities; everything else is reserved for the paid program.
 *
 * Source: Apple's "Supported capabilities (iOS)" table, the "Apple Developer"
 * (free) column — developer.apple.com/help/account/reference/supported-capabilities-ios.
 * CapMac uses this to drop capabilities a free account can't have before it signs,
 * and to tell the developer plainly which features won't work.
 */

/**
 * App ID capability types Apple grants a free account (the names its API uses).
 * These are the capabilities in the "Apple Developer" (free) column of Apple's
 * supported-capabilities table that are turned on per App ID. Network Extensions,
 * Personal VPN, Push, Sign in with Apple, Associated Domains and the rest are
 * paid-only and deliberately absent. Keychain Sharing, Background Modes and Data
 * Protection are free too but aren't App ID capabilities, so they're not listed here.
 */
export const FREE_SUPPORTED_CAPABILITIES: ReadonlySet<string> = new Set([
  'APP_GROUPS',
  'HEALTHKIT',
  'HOMEKIT',
  'INTER_APP_AUDIO',
  'WIRELESS_ACCESSORY_CONFIGURATION',
  'MAPS',
]);

/** Plain-language names for the capabilities a free account can't sign, for the warning CapMac shows. */
const PAID_ONLY_CAPABILITY_NAMES: Record<string, string> = {
  PUSH_NOTIFICATIONS: 'Push Notifications',
  APPLE_ID_AUTH: 'Sign in with Apple',
  GAME_CENTER: 'Game Center',
  ASSOCIATED_DOMAINS: 'Associated Domains',
  SIRIKIT: 'Siri',
  NFC_TAG_READING: 'NFC tag reading',
  APP_ATTEST: 'App Attest',
  WEATHERKIT: 'WeatherKit',
  USERNOTIFICATIONS_TIMESENSITIVE: 'Time-sensitive notifications',
  USERNOTIFICATIONS_COMMUNICATION: 'Communication notifications',
  CLASSKIT: 'ClassKit',
  GROUP_ACTIVITIES: 'Group activities (SharePlay)',
  MULTIPATH: 'Multipath networking',
  HOT_SPOT: 'Hotspot configuration',
  AUTOFILL_CREDENTIAL_PROVIDER: 'AutoFill credential provider',
  WALLET: 'Wallet passes',
};

export const freeCapabilityName = (type: string): string =>
  PAID_ONLY_CAPABILITY_NAMES[type] ?? type.toLowerCase().replace(/_/g, ' ');

/** How a free account's limits fall out for a set of requested capabilities. */
export interface FreeCapabilityPlan {
  /** Capabilities the free account can turn on for the App ID. */
  supported: string[];
  /** Capabilities Apple reserves for the paid program; these are dropped and reported. */
  unsupported: string[];
  /** Portal-only features (iCloud, Apple Pay) a free account cannot set up at all. */
  portalOnly: string[];
}

/**
 * Splits the capabilities an app needs into what a free account can sign and what
 * it cannot. `capabilities` and `portalOnly` come from `signingNeeds` in
 * apple-auto-signing.ts, so the two paths classify entitlements the same way.
 */
export function planFreeCapabilities(capabilities: readonly string[], portalOnly: readonly string[]): FreeCapabilityPlan {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const type of capabilities) {
    (FREE_SUPPORTED_CAPABILITIES.has(type) ? supported : unsupported).push(type);
  }
  return { supported: supported.sort(), unsupported: unsupported.sort(), portalOnly: [...portalOnly].sort() };
}

/** A one-line, newbie-English summary of what a free account will not sign, or undefined when nothing is lost. */
export function lostFeaturesSummary(plan: FreeCapabilityPlan): string | undefined {
  const names = [...plan.unsupported.map(freeCapabilityName), ...plan.portalOnly];
  if (!names.length) return undefined;
  return `A free Apple Account can’t sign these, so they won’t work in the app: ${names.join(', ')}`;
}

/** The free account's standing limits, for setup to show up front. */
export const FREE_ACCOUNT_LIMITS = [
  'The app stays installed for 7 days, then needs signing again',
  'Up to 3 of your own apps signed this way on an iPhone at once',
  'Up to 10 new app identifiers per week',
] as const;
