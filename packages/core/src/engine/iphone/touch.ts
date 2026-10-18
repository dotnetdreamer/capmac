/**
 * Turning on touch for an iPhone at this PC, on the cable or on Wi-Fi: WebDriverAgent signed with
 * the team that signs the app (its own App ID and development profile, made the way setup makes the
 * app's), then installed on the iPhone. Once per team and iPhone; the screen starts it each time.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log, withStep, type EngineContext } from '../context.js';
import { CancelledError, toErrorInfo, UserError } from '../errors.js';
import { chooseAppleSignIn, signInOnAppleWebsite } from '../wsl/apple-web.js';
import { loginAppleAccount } from '../wsl/apple-account.js';
import { savedCertificatePassword, setUpAutomaticSigning } from '../wsl/apple-auto-signing.js';
import { prepareAppleSigningDirectory } from '../wsl/apple-signing.js';
import { signWslApplication } from '../wsl/compiler.js';
import {
  DEVELOPER_MODE_STEPS, ensureWslWifiPairing, isIphoneUdid, knownIphones, selectWslDevice, wifiPairedIphone, type WslDevice, type WslDeviceOptions,
} from '../wsl/device.js';
import { toolchainConfig } from '../wsl/index.js';
import { loadWslOptions, type WslOptions } from '../wsl/settings.js';
import { inspectWslToolchain, WslExecutor } from '../wsl/toolchain.js';
import type { MirrorClient } from './receiver.js';
import { installedHashesFor, installWda, profileCovers, profileTeam, stageWdaApp, wdaBundleId } from './wda.js';

/** Touch for this iPhone: WebDriverAgent's bundle id when it is on the iPhone, else why not (the pane's view-only note). */
export type TouchState = { bundleId: string } | { unavailable: string; canSetUp: boolean };

/** Where a team's WebDriverAgent profile is kept (next to the app's profiles). */
async function wdaProfilePath(teamId: string): Promise<string> {
  return path.join(await prepareAppleSigningDirectory(), teamId, `${wdaBundleId(teamId)}.mobileprovision`);
}

/** Whether touch is on for this app's team and this iPhone, read from files only. */
export async function iphoneTouchState(cwd: string, device: Pick<WslDevice, 'udid' | 'developerMode'>): Promise<TouchState> {
  if (device.developerMode === 'disabled') return { unavailable: 'Touch needs Developer Mode on the iPhone', canSetUp: false };
  const options = await loadWslOptions({}, cwd).catch(() => ({} as WslOptions));
  if (!options.certificate || !options.profile) return { unavailable: 'Touch needs this app’s iPhone signing: set up This PC first', canSetUp: false };
  const team = await profileTeam(path.resolve(cwd, options.profile)).catch(() => undefined);
  if (!team) return { unavailable: 'Touch needs this app’s iPhone signing: set up This PC first', canSetUp: false };
  const installed = await installedHashesFor(device.udid);
  if (!installed) return { unavailable: 'Turn on touch to use the iPhone from here', canSetUp: true };
  return { bundleId: wdaBundleId(team) };
}

/**
 * The iPhone as the device tools see it now. One paired for Wi-Fi that the quick search missed counts
 * as on the Wi-Fi: one that mirrors is there, it just answered late (touch's commands wait for it).
 */
async function touchDevice(udid: string, options: WslDeviceOptions): Promise<WslDevice> {
  try {
    return await selectWslDevice(udid, options);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    const paired = await wifiPairedIphone(udid).catch(() => undefined);
    if (!paired) throw error;
    return paired;
  }
}

/**
 * The iPhone that is mirroring, when this PC has seen it on the cable: the one with the name and
 * model it gave the receiver. Of two alike, `preferred` (the pane's iPhone) if it is one of them.
 */
export async function mirroringIphone(client: MirrorClient, preferred: string): Promise<string | undefined> {
  const alike = Object.entries(await knownIphones())
    .filter(([, iphone]) => iphone.name === client.name && (!client.model || !iphone.productType || iphone.productType === client.model))
    .map(([udid]) => udid);
  return alike.length === 1 ? alike[0] : alike.find((udid) => udid.toLowerCase() === preferred.toLowerCase());
}

/**
 * Touch for this app, and the iPhone it drives as the device tools see it now: starting touch needs
 * its iOS version and whether it is on the cable or Wi-Fi (asked only when touch is set up). Touch
 * drives the iPhone in the picture: `mirroring` when this PC knows it, else `udid` (the pane's).
 */
export async function iphoneTouchTarget(cwd: string, udid: string, mirroring: MirrorClient | null = null): Promise<{ touch: TouchState; device: WslDevice }> {
  const chosen = (mirroring ? await mirroringIphone(mirroring, udid).catch(() => undefined) : undefined) ?? udid;
  const known = isIphoneUdid(chosen) ? (await knownIphones().catch(() => ({} as Awaited<ReturnType<typeof knownIphones>>)))[chosen] : undefined;
  // Named as this PC last saw it, so the pane can tell it from the iPhone that mirrors.
  const seen: WslDevice = { name: 'iPhone', ...known, udid: chosen, connection: 'usb' };
  if (!isIphoneUdid(chosen)) return { touch: { unavailable: 'Touch needs an iPhone this PC knows', canSetUp: false }, device: seen };
  const touch = await iphoneTouchState(cwd, { udid: chosen }).catch((): TouchState => ({ unavailable: 'Touch is unavailable', canSetUp: false }));
  if (!('bundleId' in touch)) return { touch, device: seen };
  try {
    const options = await loadWslOptions({}, cwd);
    return { touch, device: await touchDevice(chosen, { python: options.python }) };
  } catch (error) {
    const info = toErrorInfo(error);
    return { touch: { unavailable: info.hint ? `${info.message} ${info.hint}` : info.message, canSetUp: false }, device: seen };
  }
}

/**
 * Signs WebDriverAgent for the app's team and installs it on the iPhone, on the cable or over Wi-Fi.
 * Makes its App ID and development profile first when the team has none for it yet (or not with this
 * iPhone), after one Apple sign-in, the same one setup uses.
 */
export async function setUpIphoneTouch(input: { cwd: string; udid: string }, ctx: EngineContext, signal: AbortSignal): Promise<{ bundleId: string }> {
  const options = await loadWslOptions({}, input.cwd);
  const device = await touchDevice(input.udid, { python: options.python, signal });
  // Known on the cable only: over Wi-Fi, WebDriverAgent says so when it starts.
  if (device.developerMode === 'disabled') throw new UserError('Touch needs Developer Mode on the iPhone.', DEVELOPER_MODE_STEPS);
  if (!options.certificate || !options.profile) throw new UserError('Set up This PC for this app first.', 'Touch is signed with the same Apple team as the app.');
  const certificate = path.resolve(input.cwd, options.certificate);
  const team = await profileTeam(path.resolve(input.cwd, options.profile));
  const bundleId = wdaBundleId(team);

  // The tools the app's builds use: the check wants all of them (the SDK, the compiler, …), not just zsign.
  const report = await inspectWslToolchain(toolchainConfig(options), { signal, reuseProbe: true });
  if (!report.ready || !report.distro || !report.tools) throw new UserError('This PC’s iPhone tools are not ready.', 'Run This PC’s setup again for this app.');
  const executor = new WslExecutor(report.distro);

  let profile = await wdaProfilePath(team);
  if (!existsSync(profile) || !await profileCovers(profile, device.udid)) {
    const choice = await chooseAppleSignIn(ctx);
    const account = choice.way === 'website' ? await signInOnAppleWebsite(ctx, { signal, fresh: choice.fresh }) : await loginAppleAccount(ctx, { signal });
    if (account.team.id !== team) throw new UserError(`That Apple account’s team is ${account.team.name}, not the app’s team (${team}).`, 'Sign in with the account that signs this app.');
    const signing = await setUpAutomaticSigning(account, [{ name: 'WebDriverAgent', bundleIdentifier: bundleId, extension: false, entitlements: {} }], ctx, {
      signal, executor, connectedDevices: [{ udid: device.udid, name: device.name }],
    });
    profile = signing.profile;
  }

  const password = process.env.CAPMAC_IOS_PASSWORD ?? await savedCertificatePassword(certificate)
    ?? await ctx.prompter.password({ purpose: 'signing', message: 'Password for the Apple signing certificate (.p12):' });
  const staged = await withStep(ctx, 'Preparing WebDriverAgent for touch', 'other', () => stageWdaApp(team, { python: options.python, signal }));
  await withStep(ctx, 'Signing WebDriverAgent', 'other', () => signWslApplication(
    { bundleIdentifier: bundleId, signing: { certificatePath: certificate, provisioningProfilePath: profile, password } },
    executor, report.tools!, staged.appPath, staged.ipaPath, { signal },
  ));
  const installed = await withStep(ctx, `Installing WebDriverAgent on ${device.name}`, 'other', (step) => installWda(staged.ipaPath, device, {
    python: options.python, signal,
    // Over Wi-Fi, an asleep or locked iPhone is waited for.
    onLocked: () => {
      step.update('Unlock your iPhone to install WebDriverAgent');
      log(ctx, 'info', `Unlock ${device.name} to install WebDriverAgent. CapMac goes on as soon as you do.`);
    },
  }));
  // Once on the cable, the iPhone is paired for Wi-Fi too (no prompt on it), so touch works without the cable later.
  await ensureWslWifiPairing(device, { python: options.python, signal }).catch((error: unknown) => {
    log(ctx, 'note', `${device.name} could not be set up for touch over Wi-Fi: ${error instanceof Error ? error.message : String(error)}`);
  });
  log(ctx, 'success', installed ? `Touch is on for ${device.name}.` : `Touch was already on for ${device.name}.`);
  return { bundleId };
}
