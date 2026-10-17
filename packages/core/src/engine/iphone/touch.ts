/**
 * Turning on touch for an iPhone plugged into this PC: WebDriverAgent signed with the team that
 * signs the app (its own App ID and development profile, made the way setup makes the app's),
 * then installed on the iPhone. Once per team and iPhone; the screen starts it each time.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log, withStep, type EngineContext } from '../context.js';
import { toErrorInfo, UserError } from '../errors.js';
import { chooseAppleSignIn, signInOnAppleWebsite } from '../wsl/apple-web.js';
import { loginAppleAccount } from '../wsl/apple-account.js';
import { savedCertificatePassword, setUpAutomaticSigning } from '../wsl/apple-auto-signing.js';
import { prepareAppleSigningDirectory } from '../wsl/apple-signing.js';
import { signWslApplication } from '../wsl/compiler.js';
import { DEVELOPER_MODE_STEPS, selectWslDevice, type WslDevice } from '../wsl/device.js';
import { toolchainConfig } from '../wsl/index.js';
import { loadWslOptions, type WslOptions } from '../wsl/settings.js';
import { inspectWslToolchain, WslExecutor } from '../wsl/toolchain.js';
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
 * Touch for this iPhone in this app, and the iPhone as the device tools see it now: starting touch
 * needs its iOS version and whether it is on the cable or Wi-Fi. Looked up only when touch is set up.
 */
export async function iphoneTouchTarget(cwd: string, udid: string): Promise<{ touch: TouchState; device: WslDevice }> {
  const unknown: WslDevice = { udid, name: 'iPhone', connection: 'usb' };
  const touch = await iphoneTouchState(cwd, { udid }).catch((): TouchState => ({ unavailable: 'Touch is unavailable', canSetUp: false }));
  if (!('bundleId' in touch)) return { touch, device: unknown };
  try {
    const options = await loadWslOptions({}, cwd);
    return { touch, device: await selectWslDevice(udid, { python: options.python }) };
  } catch (error) {
    const info = toErrorInfo(error);
    return { touch: { unavailable: info.hint ? `${info.message} ${info.hint}` : info.message, canSetUp: false }, device: unknown };
  }
}

/**
 * Signs WebDriverAgent for the app's team and installs it on the iPhone. Makes its App ID and
 * development profile first when the team has none for it yet (or not with this iPhone), after
 * one Apple sign-in, the same one setup uses.
 */
export async function setUpIphoneTouch(input: { cwd: string; udid: string }, ctx: EngineContext, signal: AbortSignal): Promise<{ bundleId: string }> {
  const options = await loadWslOptions({}, input.cwd);
  const device = await selectWslDevice(input.udid, { python: options.python, signal });
  if (device.connection !== 'usb') throw new UserError('Plug the iPhone into this PC to turn on touch.', 'Its screen and touch come over the cable.');
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
  const installed = await withStep(ctx, `Installing WebDriverAgent on ${device.name}`, 'other', () => installWda(staged.ipaPath, device, { python: options.python, signal }));
  log(ctx, 'success', installed ? `Touch is on for ${device.name}.` : `Touch was already on for ${device.name}.`);
  return { bundleId };
}
