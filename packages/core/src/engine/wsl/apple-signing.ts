/** Apple signing inventory and additive provisioning. No existing resource is revoked or deleted. */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, chmod, writeFile, readFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import plist from 'plist';
import { CancelledError, UserError } from '../errors.js';
import type { WslExecutor } from './toolchain.js';

const ORIGIN = 'https://api.appstoreconnect.apple.com';
type Attributes = Record<string, unknown>;
export interface AppleResource { id: string; type: string; attributes: Attributes; relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] }> }
interface AppleDocument { data: AppleResource | AppleResource[]; links?: { next?: string | null }; errors?: { code?: string; title?: string; detail?: string }[] }
export interface AppleSigningCredentials { issuerId: string; keyId: string; privateKey: string }
export class AppleSigningApiError extends UserError {
  constructor(readonly status: number, message: string) { super(message, status === 403 ? 'This App Store Connect key does not have permission for this signing operation. Existing certificates and profiles were preserved.' : undefined); }
}

/** Tokens stay in memory and Authorization is never included in diagnostics. */
export function createAppleSigningToken(credentials: AppleSigningCredentials, now = Math.floor(Date.now() / 1000)): string {
  if (!/^[A-Za-z0-9_-]+$/.test(credentials.keyId) || !/^[A-Za-z0-9-]+$/.test(credentials.issuerId)) throw new UserError('Invalid Apple API issuer or key identifier.');
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'ES256', kid: credentials.keyId, typ: 'JWT' })}.${encode({ iss: credentials.issuerId, iat: now - 5, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
  const key = createPrivateKey(credentials.privateKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new UserError('The Apple API signing key must be an ES256 P-256 key.');
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

export class AppleSigningClient {
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;
  #credentials: AppleSigningCredentials;
  constructor(credentials: AppleSigningCredentials, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.#credentials = credentials;
    this.transport = options.fetch ?? fetch; this.timeoutMs = options.timeoutMs ?? 20_000;
    if (this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new UserError('Apple API timeout must be between 1 and 60000 milliseconds.');
  }
  async request(method: 'GET' | 'POST', resource: string, body?: object, signal?: AbortSignal): Promise<AppleDocument> {
    if (signal?.aborted) throw new CancelledError();
    const url = new URL(resource, ORIGIN);
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/v1/') || url.username || url.password) throw new UserError('Refusing to send Apple signing credentials to an unrelated API URL.');
    let response: Response;
    try {
      response = await this.transport(url, { method, headers: { Authorization: `Bearer ${createAppleSigningToken(this.#credentials)}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs) });
    } catch {
      if (signal?.aborted) throw new CancelledError();
      throw new UserError('The Apple signing API could not be reached within its timeout.');
    }
    const text = await response.text();
    if (text.length > 8_000_000) throw new UserError('The Apple signing API returned an unexpectedly large response.');
    let document: AppleDocument;
    try { document = JSON.parse(text) as AppleDocument; } catch { throw new AppleSigningApiError(response.status, 'The Apple signing API returned an invalid JSON response.'); }
    if (!response.ok) {
      const errors = document.errors?.map((error) => `${error.code ?? ''}: ${error.title ?? ''}${error.detail ? '. ' + error.detail : ''}`).join('; ').slice(0, 1200);
      throw new AppleSigningApiError(response.status, `Apple signing API ${response.status}${errors ? ': ' + errors : ''}`);
    }
    if (!document.data || (typeof document.data !== 'object')) throw new UserError('The Apple signing API response has no resource data.');
    return document;
  }
  async list(resource: string, signal?: AbortSignal): Promise<AppleResource[]> {
    const items: AppleResource[] = []; let next: string | undefined = resource;
    const visited = new Set<string>();
    while (next) {
      if (visited.has(next) || visited.size >= 100) throw new UserError('Apple signing pagination did not complete.');
      visited.add(next); const page = await this.request('GET', next, undefined, signal);
      if (!Array.isArray(page.data)) throw new UserError('Apple signing list returned a single resource.');
      items.push(...page.data); next = page.links?.next ?? undefined;
    }
    return items;
  }
}

function relationship(resource: AppleResource, key: string): string[] {
  const value = resource.relationships?.[key]?.data;
  return !value ? [] : (Array.isArray(value) ? value : [value]).map((item) => item.id);
}
function one(document: AppleDocument): AppleResource {
  if (Array.isArray(document.data)) throw new UserError('Apple signing creation returned a resource list.');
  return document.data;
}
export interface AppleProfileDetails { entitlements: Record<string, plist.PlistValue>; expirationDate: Date; bundleIdentifier: string; deviceUdids: string[] }
/** Inspect Apple's returned CMS profile. Final code signing independently verifies the CMS signature. */
export function inspectAppleProfileContent(content: string): AppleProfileDetails {
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(content)) throw new UserError('Apple returned invalid provisioning profile content.');
  const bytes = Buffer.from(content, 'base64'); const begin = bytes.indexOf('<?xml'); const end = bytes.indexOf('</plist>', begin);
  if (begin < 0 || end < begin) throw new UserError('The Apple provisioning profile has no readable property list.');
  const data = plist.parse(bytes.subarray(begin, end + 8).toString('utf8')) as Record<string, plist.PlistValue>;
  const entitlements = data.Entitlements as Record<string, plist.PlistValue> | undefined;
  if (!entitlements || typeof entitlements !== 'object') throw new UserError('The Apple provisioning profile has no entitlements.');
  const expirationDate = data.ExpirationDate instanceof Date ? data.ExpirationDate : new Date(String(data.ExpirationDate));
  if (!Number.isFinite(expirationDate.getTime())) throw new UserError('The Apple provisioning profile has no valid expiration date.');
  return { entitlements, expirationDate, bundleIdentifier: String(entitlements['application-identifier'] ?? '').split('.').slice(1).join('.'), deviceUdids: Array.isArray(data.ProvisionedDevices) ? data.ProvisionedDevices.filter((value): value is string => typeof value === 'string') : [] };
}

export interface AppleSigningInventory {
  certificates: AppleResource[];
  devices: AppleResource[];
  profiles: AppleResource[];
  bundleIds: AppleResource[];
  capabilities: Record<string, AppleResource[]>;
  /** Public API exposes APP_GROUPS capability, but not app-group assignment management. */
  appGroups: { assignmentApiAvailable: false; identifiersFromProfiles: string[] };
}
export async function readAppleSigningInventory(client: AppleSigningClient, bundleIdentifiers: string[], options: { signal?: AbortSignal } = {}): Promise<AppleSigningInventory> {
  const signal = options.signal;
  const [certificates, devices, profiles, candidates] = await Promise.all([
    client.list('/v1/certificates?limit=200', signal), client.list('/v1/devices?limit=200', signal),
    client.list('/v1/profiles?limit=200&include=bundleId,certificates,devices', signal),
    client.list('/v1/bundleIds?limit=200&filter[identifier]=' + encodeURIComponent(bundleIdentifiers.join(',')), signal),
  ]);
  // Apple's identifier filter can also return identifiers with that prefix.
  const bundleIds = candidates.filter((bundle) => bundleIdentifiers.includes(String(bundle.attributes.identifier)));
  // This relationship endpoint rejects the list endpoints' `limit` parameter.
  const capabilities = Object.fromEntries(await Promise.all(bundleIds.map(async (bundle) => [String(bundle.attributes.identifier), await client.list(`/v1/bundleIds/${encodeURIComponent(bundle.id)}/bundleIdCapabilities`, signal)] as const)));
  const groups = new Set<string>();
  for (const profile of profiles) if (typeof profile.attributes.profileContent === 'string') {
    const content = inspectAppleProfileContent(profile.attributes.profileContent);
    const declared = content.entitlements['com.apple.security.application-groups'];
    if (Array.isArray(declared)) for (const group of declared) if (typeof group === 'string') groups.add(group);
  }
  return { certificates, devices, profiles, bundleIds, capabilities, appGroups: { assignmentApiAvailable: false, identifiersFromProfiles: [...groups] } };
}

export interface AppleSigningRequirement { bundleIdentifier: string; entitlements: Record<string, plist.PlistValue> }
export interface AppleSigningPlan {
  profileType: 'IOS_APP_DEVELOPMENT' | 'IOS_APP_ADHOC';
  createCertificate: boolean;
  certificateIds: string[];
  deviceIds: string[];
  reuseProfiles: { bundleIdentifier: string; profileId: string }[];
  createProfiles: { bundleIdentifier: string; bundleId: string; name: string; entitlements: Record<string, plist.PlistValue> }[];
  enableCapabilities: { bundleIdentifier: string; bundleId: string; capabilityType: string }[];
  requirements: AppleSigningRequirement[];
  blockers: string[];
}
const CAPABILITIES: Record<string, string> = { 'aps-environment': 'PUSH_NOTIFICATIONS', 'com.apple.developer.applesignin': 'APPLE_ID_AUTH', 'com.apple.developer.game-center': 'GAME_CENTER', 'com.apple.developer.associated-domains': 'ASSOCIATED_DOMAINS', 'com.apple.security.application-groups': 'APP_GROUPS' };
function allowed(requested: plist.PlistValue, grant: plist.PlistValue | undefined): boolean {
  if (Array.isArray(requested)) return requested.every((value) => (Array.isArray(grant) ? grant : grant === undefined ? [] : [grant]).some((item) => allowed(value, item)));
  if (typeof requested === 'string' && typeof grant === 'string') return new RegExp('^' + grant.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(requested);
  return requested === grant;
}
export function appleProfileCovers(content: AppleProfileDetails, requirement: AppleSigningRequirement, now = new Date()): boolean {
  return content.expirationDate > now && allowed(requirement.bundleIdentifier, content.bundleIdentifier) && Object.entries(requirement.entitlements).every(([key, value]) => allowed(value, content.entitlements[key]));
}

/** Resolve reuse first. New profiles/certificates are explicit steps for the caller to review. */
export function planAppleSigning(inventory: AppleSigningInventory, requirements: AppleSigningRequirement[], options: { certificateIds?: string[]; deviceIds?: string[]; profileType?: AppleSigningPlan['profileType']; now?: Date } = {}): AppleSigningPlan {
  const now = options.now ?? new Date(); const profileType = options.profileType ?? 'IOS_APP_DEVELOPMENT';
  const certificateTypes = profileType === 'IOS_APP_DEVELOPMENT' ? ['DEVELOPMENT', 'IOS_DEVELOPMENT'] : ['DISTRIBUTION', 'IOS_DISTRIBUTION'];
  // Only caller-identified certificates with an available private key can be reused.
  const certificateIds = (options.certificateIds ?? []).filter((id) => inventory.certificates.some((item) => item.id === id && certificateTypes.includes(String(item.attributes.certificateType)) && new Date(String(item.attributes.expirationDate)) > now));
  const deviceIds = options.deviceIds ?? inventory.devices.filter((device) => device.attributes.status === 'ENABLED' && device.attributes.platform === 'IOS').map((device) => device.id);
  const plan: AppleSigningPlan = { profileType, createCertificate: !certificateIds.length, certificateIds, deviceIds, reuseProfiles: [], createProfiles: [], enableCapabilities: [], requirements, blockers: [] };
  if (!deviceIds.length) plan.blockers.push('No registered, enabled iOS device is available for a development or ad hoc profile.');
  if (deviceIds.some((id) => !inventory.devices.some((device) => device.id === id && device.attributes.status === 'ENABLED' && device.attributes.platform === 'IOS'))) plan.blockers.push('A selected provisioning device is unavailable or disabled.');
  for (const requirement of requirements) {
    const bundle = inventory.bundleIds.find((item) => item.attributes.identifier === requirement.bundleIdentifier);
    if (!bundle) { plan.blockers.push(`The Apple account has no App ID for ${requirement.bundleIdentifier}.`); continue; }
    const matches = inventory.profiles.filter((profile) => profile.attributes.profileType === profileType && profile.attributes.profileState === 'ACTIVE' && relationship(profile, 'bundleId').includes(bundle.id) && certificateIds.some((id) => relationship(profile, 'certificates').includes(id)) && deviceIds.every((id) => relationship(profile, 'devices').includes(id)) && typeof profile.attributes.profileContent === 'string' && appleProfileCovers(inspectAppleProfileContent(String(profile.attributes.profileContent)), requirement, now));
    matches.sort((a, b) => new Date(String(b.attributes.expirationDate)).getTime() - new Date(String(a.attributes.expirationDate)).getTime());
    if (matches[0]) { plan.reuseProfiles.push({ bundleIdentifier: requirement.bundleIdentifier, profileId: matches[0].id }); continue; }
    for (const entitlement of Object.keys(requirement.entitlements)) {
      const capabilityType = CAPABILITIES[entitlement];
      if (capabilityType && !inventory.capabilities[requirement.bundleIdentifier]?.some((item) => item.attributes.capabilityType === capabilityType)) plan.enableCapabilities.push({ bundleIdentifier: requirement.bundleIdentifier, bundleId: bundle.id, capabilityType });
    }
    plan.createProfiles.push({ bundleIdentifier: requirement.bundleIdentifier, bundleId: bundle.id, name: `CapMac ${requirement.bundleIdentifier} ${now.toISOString().replace(/[:.]/g, '-')}`, entitlements: requirement.entitlements });
  }
  return plan;
}

/** User-only storage, outside repositories. Profiles and certificates never contain API tokens. */
export async function prepareAppleSigningDirectory(directory = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'CapMac', 'Signing')): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new UserError('The signing cache directory must not be a symbolic link.');
  if (process.platform === 'win32') {
    const exec = promisify(execFile); const identity = (await exec('whoami', [], { windowsHide: true })).stdout.trim();
    if (!identity || /[\r\n\0]/.test(identity)) throw new UserError('Could not resolve the Windows account for private signing storage.');
    await exec('icacls', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { windowsHide: true });
  } else await chmod(directory, 0o700);
  return path.resolve(directory);
}
async function savePrivate(directory: string, filename: string, bytes: Buffer): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) throw new UserError('Unsafe signing artifact filename.');
  const destination = path.join(directory, filename);
  try { await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(destination)).equals(bytes)) throw error;
  }
  if (process.platform !== 'win32') await chmod(destination, 0o600);
  return destination;
}

/** Additive mutations only. Call after reviewing the concrete plan; no certificate or device is revoked. */
export async function applyAppleSigningPlan(client: AppleSigningClient, plan: AppleSigningPlan, options: { csrContent?: string; directory?: string; signal?: AbortSignal } = {}): Promise<{ certificate?: AppleResource; certificatePath?: string; profilePaths: Record<string, string> }> {
  if (plan.blockers.length) throw new UserError('Apple signing setup has unresolved prerequisites.', undefined, plan.blockers);
  if (plan.createCertificate && !options.csrContent) throw new UserError('A new Apple development certificate requires a certificate signing request.');
  const directory = await prepareAppleSigningDirectory(options.directory); const signal = options.signal;
  let certificate: AppleResource | undefined; let certificatePath: string | undefined;
  const certificateIds = [...plan.certificateIds];
  if (plan.createCertificate) {
    certificate = one(await client.request('POST', '/v1/certificates', { data: { type: 'certificates', attributes: { certificateType: plan.profileType === 'IOS_APP_DEVELOPMENT' ? 'DEVELOPMENT' : 'DISTRIBUTION', csrContent: options.csrContent } } }, signal));
    certificateIds.push(certificate.id);
    if (typeof certificate.attributes.certificateContent !== 'string') throw new UserError('Apple created a certificate but did not return its content. Preserve the matching private key for recovery.');
    certificatePath = await savePrivate(directory, `certificate-${certificate.id}.cer`, Buffer.from(certificate.attributes.certificateContent, 'base64'));
  }
  for (const capability of plan.enableCapabilities) await client.request('POST', '/v1/bundleIdCapabilities', { data: { type: 'bundleIdCapabilities', attributes: { capabilityType: capability.capabilityType }, relationships: { bundleId: { data: { type: 'bundleIds', id: capability.bundleId } } } } }, signal);
  const profiles: { bundleIdentifier: string; resource: AppleResource }[] = [];
  for (const reused of plan.reuseProfiles) profiles.push({ bundleIdentifier: reused.bundleIdentifier, resource: one(await client.request('GET', `/v1/profiles/${encodeURIComponent(reused.profileId)}`, undefined, signal)) });
  for (const creation of plan.createProfiles) profiles.push({ bundleIdentifier: creation.bundleIdentifier, resource: one(await client.request('POST', '/v1/profiles', { data: { type: 'profiles', attributes: { name: creation.name, profileType: plan.profileType }, relationships: {
    bundleId: { data: { type: 'bundleIds', id: creation.bundleId } }, certificates: { data: certificateIds.map((id) => ({ type: 'certificates', id })) }, devices: { data: plan.deviceIds.map((id) => ({ type: 'devices', id })) },
  } } }, signal)) });
  const profilePaths: Record<string, string> = {};
  for (const { bundleIdentifier, resource } of profiles) {
    const content = resource.attributes.profileContent; const requirement = plan.requirements.find((item) => item.bundleIdentifier === bundleIdentifier);
    if (typeof content !== 'string' || !requirement || !appleProfileCovers(inspectAppleProfileContent(content), requirement)) throw new UserError(`Apple's profile for ${bundleIdentifier} does not grant the app's required capabilities.`, 'Existing profiles were preserved. Check the App ID app-group assignment; the public API cannot assign a group to an App ID.');
    profilePaths[bundleIdentifier] = await savePrivate(directory, `profile-${resource.id}.mobileprovision`, Buffer.from(content, 'base64'));
  }
  return { ...(certificate ? { certificate } : {}), ...(certificatePath ? { certificatePath } : {}), profilePaths };
}

export interface AppleSigningRequest { directory: string; privateKeyPath: string; csrContent: string }
function validateRequestDirectory(request: AppleSigningRequest): void {
  if (!/^\/tmp\/capmac-csr\.[A-Za-z0-9]+$/.test(request.directory) || request.privateKeyPath !== `${request.directory}/identity.key`) throw new UserError('Unexpected private signing request directory.');
}

/** Generate the private key only in a 0700 WSL temporary directory. Only the public CSR leaves it. */
export async function createAppleSigningRequest(executor: WslExecutor, options: { commonName?: string; signal?: AbortSignal } = {}): Promise<AppleSigningRequest> {
  const commonName = options.commonName ?? 'CapMac iOS Development';
  if (!/^[A-Za-z0-9 ._-]{1,100}$/.test(commonName)) throw new UserError('The signing certificate name contains unsupported characters.');
  const directory = (await executor.run(['mktemp', '-d', '-t', 'capmac-csr.XXXXXXXX'], { signal: options.signal })).stdout.trim();
  const request: AppleSigningRequest = { directory, privateKeyPath: `${directory}/identity.key`, csrContent: '' }; validateRequestDirectory(request);
  try {
    await executor.run(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-batch', '-subj', `/CN=${commonName}`, '-keyout', request.privateKeyPath, '-out', `${directory}/request.csr`], { signal: options.signal, timeoutMs: 60_000 });
    await executor.run(['chmod', '600', request.privateKeyPath], { signal: options.signal });
    await executor.run(['openssl', 'req', '-verify', '-noout', '-in', `${directory}/request.csr`], { signal: options.signal });
    request.csrContent = (await executor.run(['cat', `${directory}/request.csr`], { signal: options.signal })).stdout;
    if (!request.csrContent.startsWith('-----BEGIN CERTIFICATE REQUEST-----')) throw new UserError('OpenSSL did not generate a certificate signing request.');
    return request;
  } catch (error) { await removeAppleSigningRequest(executor, request); throw error; }
}

/** Export a new identity without passing its password in command arguments or overwriting an existing identity. */
export async function exportAppleSigningIdentity(executor: WslExecutor, request: AppleSigningRequest, certificatePath: string, password: string, options: { directory?: string; signal?: AbortSignal } = {}): Promise<string> {
  validateRequestDirectory(request);
  if (/[\r\n\0]/.test(password)) throw new UserError('The signing identity password cannot contain newlines or NUL characters.');
  const directory = await prepareAppleSigningDirectory(options.directory);
  const output = path.join(directory, `ios-development-${randomUUID()}.p12`);
  const certificate = await executor.path(certificatePath, options.signal); const destination = await executor.path(output, options.signal);
  await executor.run(['openssl', 'x509', '-inform', 'DER', '-in', certificate, '-out', `${request.directory}/certificate.pem`], { signal: options.signal });
  await executor.run(['openssl', 'pkcs12', '-export', '-inkey', request.privateKeyPath, '-in', `${request.directory}/certificate.pem`, '-name', 'CapMac iOS Development', '-out', `${request.directory}/identity.p12`, '-passout', 'stdin'], { signal: options.signal, stdin: password + '\n' });
  await executor.run(['python3', '-c', 'import os,pathlib,sys; content=pathlib.Path(sys.argv[1]).read_bytes(); fd=os.open(sys.argv[2],os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); f=os.fdopen(fd,"wb"); f.write(content); f.close()', `${request.directory}/identity.p12`, destination], { signal: options.signal });
  return output;
}

/** Cleanup is explicit so a successful Apple certificate can be recovered if a later profile operation fails. */
export async function removeAppleSigningRequest(executor: WslExecutor, request: AppleSigningRequest): Promise<void> {
  validateRequestDirectory(request);
  await executor.run(['rm', '-rf', '--', request.directory], { allowFailure: true });
}
