import { Command, Option } from 'commander';
import { appsCommand, appsUseCommand } from './commands/apps.js';
import { backendCommand, commandBackend } from './commands/backend.js';
import { buildCommand } from './commands/build.js';
import { capCommand } from './commands/cap.js';
import { devCommand } from './commands/dev.js';
import { doctorCommand } from './commands/doctor.js';
import { macsCommand, pairCommand, setDefaultCommand, unpairCommand } from './commands/pair.js';
import {
  remoteOffCommand,
  remoteOnCommand,
  remotePcsCommand,
  remoteRevokeCommand,
  remoteServerCommand,
  remoteSetCommand,
  remoteStatusCommand,
  remoteTestCommand,
} from './commands/remote.js';
import { runCommand } from './commands/run.js';
import { wslBuildCommand, wslDevCommand, wslDoctorCommand, wslRunCommand, wslSetupCommand, wslTargetsCommand, type WslCommandOptions } from './commands/wsl.js';
import { dialogCommand } from './commands/dialog.js';
import { screenshotCommand } from './commands/screenshot.js';
import { skillAddCommand, skillRemoveCommand, skillShowCommand, skillStatusCommand } from './commands/skill.js';
import { takeoverByDefault, takeoverCommand } from './commands/takeover.js';
import {
  cleanCommand,
  execCommand,
  infoCommand,
  keychainCommand,
  logsCommand,
  openXcodeCommand,
  pullCommand,
  screenCommand,
  syncCommand,
  targetsCommand,
} from './commands/tools.js';
import { setRouteOverride } from '@capmac/core/engine';
import { RELAY_CHOICES, ROUTE_CHOICES, type RouteChoice } from '@capmac/core/shared/remote';
import { reportError } from './report.js';
import { setVerbose } from './ui.js';

declare const __CAPMAC_VERSION__: string | undefined;
const VERSION = typeof __CAPMAC_VERSION__ === 'string' ? __CAPMAC_VERSION__ : 'dev';

const collect = (value: string, previous: string[] = []) => [...previous, value];

function wrap<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      reportError(err);
      process.exitCode = process.exitCode && process.exitCode !== 0 ? process.exitCode : 1;
    }
  };
}

/** --backend, else the project's pick (`capmac backend`, or CapMac Studio), else the Mac. */
function backendAction<T>(
  macCommand: (options: T) => Promise<void>,
  wslCommand: (options: WslCommandOptions) => Promise<void>,
): (options: T & WslCommandOptions) => Promise<void> {
  return wrap(async (options: T & WslCommandOptions) => (await commandBackend(options.backend, options.app)) === 'wsl' ? wslCommand(options) : macCommand(options));
}

const program = new Command();
program
  .name('capmac')
  .description('Build, run and live-reload apps from Windows: use a paired Mac, or build iOS apps locally with the experimental WSL backend.')
  .version(VERSION, '-V, --version')
  .option('-v, --verbose', 'show full tool output')
  .showHelpAfterError()
  .hook('preAction', async (cmd, action) => {
    if (cmd.opts().verbose || cmd.optsWithGlobals?.().verbose) setVerbose(true);
    // --route is "this time" everywhere except `capmac remote set`, where it is the Mac's setting.
    const route = action.opts().route as RouteChoice | undefined;
    if (route && !(action.name() === 'set' && action.parent?.name() === 'remote')) setRouteOverride(route);
    // Takeover is on by default: the first capmac command (usually `capmac pair`) turns it on.
    // Commands that build on this PC never turn on the Mac's.
    const backendCommands = ['doctor', 'run', 'dev', 'build'];
    const wsl = action.parent?.name() === 'wsl' || action.name() === 'backend'
      || (action.parent === program && backendCommands.includes(action.name()) && (await commandBackend(action.opts().backend, action.opts().app)) === 'wsl');
    if (action.name() !== 'takeover' && !wsl) await takeoverByDefault();
  });

const mac = () => new Option('--mac <name>', 'which paired Mac to use');
const routeOption = () => new Option('--route <how>', 'how to reach the Mac this time (default: its remote-access setting)').choices(ROUTE_CHOICES);
const soundOption = () => new Option('--sound <where>', "an Electron app's sound: off, on the mac, or on this pc (in the window viewer); remembered for the project (default off)").choices(['off', 'mac', 'pc']);
const streamOption = () => new Option('--stream <how>', 'how the screen viewer streams: smooth (video, far less data) or compatible (pictures); remembered, and CapMac Studio uses it too (default smooth)').choices(['smooth', 'compatible']);

const appOption = () => new Option('-a, --app <app>', "which of the project's apps: ios or electron (see `capmac apps`; default: the one picked with `capmac apps use` or in CapMac Studio)");

function wslOptions(cmd: Command): Command {
  return cmd
    .option('--distro <name>', 'WSL distribution to use (default: your WSL default)')
    .option('--sdk <path>', 'iPhoneOS SDK directory you provide')
    .option('--swift <path>', 'Swift compiler in WSL (default: swiftc)')
    .option('--swift-resources <path>', 'matching Darwin Swift modules and runtime resources, when separate from the compiler')
    .option('--clang <path>', 'C/Objective-C/C++ compiler in WSL (default: next to swiftc)')
    .option('--archive <path>', 'LLVM archive tool in WSL (default: llvm-ar)')
    .option('--lipo <path>', 'LLVM Mach-O architecture tool in WSL (auto-detected)')
    .option('--strip <path>', 'LLVM Mach-O symbol stripping tool in WSL (auto-detected)')
    .option('--ruby <path>', 'Ruby executable in WSL for CocoaPods project export')
    .option('--pod <path>', 'CocoaPods executable in WSL (default: pod)')
    .option('--actool <path>', 'asset catalog compiler in WSL')
    .option('--ibtool <path>', 'storyboard and XIB compiler in WSL')
    .option('--momc <path>', 'Core Data model compiler in WSL')
    .option('--xcstrings <path>', 'string catalog compiler in WSL')
    .option('--xcode-version <version>', 'Xcode version matching the supplied Apple SDK, for build-script metadata')
    .option('--linker <path>', 'Mach-O linker in WSL (default: ld64.lld)')
    .option('--signer <path>', 'zsign executable in WSL (default: zsign)')
    .option('--python <path>', 'your own Windows Python with pymobiledevice3 (default: the one CapMac sets up)')
    .option('--certificate <file>', 'Apple signing certificate and private key (.p12)')
    .option('--profile <file>', 'development provisioning profile for your app and iPhone (.mobileprovision)')
    .option('--extension-profile <bundle-id=path...>', 'provisioning profiles for embedded application extensions')
    .option('--password-env <name>', 'environment variable containing the .p12 password (never a command-line password)');
}

function backendOptions(cmd: Command): Command {
  return wslOptions(cmd.addOption(new Option('--backend <name>', 'build on a paired Mac, or on this PC with WSL (experimental); default: the project\'s pick, see `capmac backend`').choices(['mac', 'wsl'])));
}

function targetOptions(cmd: Command): Command {
  return cmd
    .addOption(appOption())
    .option('-t, --target <name|udid>', 'simulator or device to use (see `capmac targets`); "mac" for the Electron app')
    .option('-d, --device', 'run on a connected iPhone/iPad instead of a simulator')
    .option('-s, --simulator', 'only consider simulators')
    .option('-e, --electron', "the Electron app, on the Mac's desktop (a Capacitor app with iOS too)");
}

function buildOptions(cmd: Command): Command {
  return cmd
    .option('-c, --configuration <name>', 'Xcode build configuration (Debug, Release, …)')
    .option('--scheme <name>', 'Xcode scheme (default: App)')
    .option('--team <id>', 'Apple Developer Team ID for signing (device builds)')
    .option('--clean', 'clean build products first')
    .option('--full', 'reinstall node_modules on the Mac and run a full `cap sync`')
    .option('--all-warnings', 'also show warnings from Pods / Swift packages')
    .option('--xcodebuild-arg <arg>', 'extra argument passed to xcodebuild (repeatable)', collect)
    .option('--api-key <file>', 'App Store Connect API key (.p8) so Xcode can sign/register devices over SSH')
    .option('--api-key-id <id>', 'API key ID (read from AuthKey_<ID>.p8 if omitted)')
    .option('--api-issuer <id>', 'API key issuer ID');
}

program
  .command('pair [mac]')
  .description('pair this PC with a Mac over SSH (finds Macs on your network if none is given)')
  .option('--name <alias>', 'short name for this Mac')
  .option('--identity <file>', 'use this private key instead of CapMac\'s own')
  .option('--agent', 'authenticate with the Windows OpenSSH agent')
  .option('--password-env <var>', 'read the Mac password from this environment variable (CI)')
  .option('-y, --yes', 'trust the host key and install Node.js without asking')
  .option('--default', 'make this the default Mac')
  .option('--remote', 'also reach this Mac from anywhere, over the internet (remote access)')
  .option('--no-remote', 'do not ask about remote access')
  .option('--signal-url <url>', 'your signaling server for remote access (wss://…)')
  .action(wrap(pairCommand));

program.command('macs').description('list paired Macs').action(wrap(macsCommand));
program.command('use <name>').description('make a paired Mac the default').action(wrap(setDefaultCommand));
program.command('unpair <name>').description('forget a paired Mac').action(wrap(unpairCommand));

backendOptions(program
  .command('doctor')
  .description('check this PC and the Mac, or the local iOS toolchain with --backend wsl')
  .addOption(mac()).addOption(routeOption())
  .option('--fix', 'fix what can be fixed (license, Node.js, iOS platform, AXe…)')
  .option('-y, --yes', 'do not ask before fixing')
  .option('--json', 'machine-readable WSL readiness report (--backend wsl)'))
  .action(backendAction(doctorCommand, wslDoctorCommand));

backendOptions(buildOptions(targetOptions(
  program
    .command('run')
    .description("build the web app, sync, build on the Mac and launch on a simulator or device (an Electron app: on the Mac's desktop)")
    .addOption(mac()).addOption(routeOption())
    .option('--release', 'shortcut for --configuration Release')
    .option('--unsigned', 'with --backend wsl, compile and package without signing or installing')
    .option('--no-web-build', 'do not run the web build first (use the existing web dir)')
    .option('--no-logs', 'launch and return instead of streaming app logs')
    .option('--for <seconds>', "stream the app's console for this long, then stop (scripts, AI agents)")
    .option('--show-simulator', 'also open the Simulator window on the Mac\'s screen')
    .option('--os-logs', 'also show NSLog/os_log output, like Xcode\'s console')
    .option('--bridge', 'show Capacitor bridge traffic in the logs')
    .addOption(soundOption()),
))).action(backendAction(runCommand, wslRunCommand));

backendOptions(buildOptions(targetOptions(
  program
    .command('dev')
    .description('live reload: your dev server runs here, the app on the Mac loads it through an SSH tunnel (an Electron app reloads on the Mac as you save)')
    .addOption(mac()).addOption(routeOption())
    .option('--url <url>', 'use an already running dev server (e.g. http://localhost:5173)')
    .option('--dev-command <cmd>', 'command that starts the dev server (default: the "dev"/"start" script)')
    .option('--live-host <host>', 'with --backend wsl, PC address reachable by the iPhone')
    .option('--screen', 'open the remote simulator screen in your browser')
    .option('--no-watch', 'do not rebuild automatically when native files change')
    .option('--show-simulator', 'also open the Simulator window on the Mac\'s screen')
    .option('--os-logs', 'also show NSLog/os_log output, like Xcode\'s console')
    .option('--bridge', 'show Capacitor bridge traffic in the logs')
    .addOption(soundOption())
    .addOption(streamOption()),
))).action(backendAction(devCommand, wslDevCommand));

backendOptions(buildOptions(targetOptions(
  program
    .command('build')
    .description('build on the Mac without launching; --ipa exports a signed .ipa to this PC')
    .addOption(mac()).addOption(routeOption())
    .option('--release', 'shortcut for --configuration Release')
    .option('--no-web-build', 'do not run the web build first')
    .option('--ipa', 'archive and export an .ipa, then download it')
    .option('--export <type>', 'export type: development | ad-hoc | app-store | enterprise')
    .option('--upload', 'archive and upload to App Store Connect / TestFlight')
    .option('-o, --out <dir>', 'where to save the .ipa (default: build/ios)'),
))).action(backendAction(buildCommand, wslBuildCommand));

const wsl = program
  .command('wsl')
  .description('experimental iOS builds on Windows through WSL, with no Mac connection: setup | doctor | targets | build | run | dev');
wslOptions(wsl.command('setup').description('set up the WSL toolchain and sign in to Apple for the iPhone SDK'))
  .option('--apple-login', 'sign in to Apple again in this terminal')
  .option('--xcode <file.xip>', 'import the SDK from an official Xcode archive already downloaded')
  .option('--install-resources', 'install pinned open-source asset/storyboard/model/string compilers in WSL')
  .action(wrap(wslSetupCommand));
wslOptions(wsl.command('doctor').description('check WSL, the iOS toolchain, SDK and signing inputs'))
  .option('--json', 'machine-readable readiness report')
  .action(wrap(wslDoctorCommand));
wslOptions(wsl.command('targets').description('list iPhones connected to this PC (no SDK or Mac needed)'))
  .option('--json', 'machine-readable device list')
  .action(wrap(wslTargetsCommand));

function wslProjectOptions(cmd: Command): Command {
  return wslOptions(cmd)
    .option('--scheme <name>', 'native application scheme (default: detected application)')
    .option('-c, --configuration <name>', 'native build configuration (default: Debug)')
    .option('--unsigned', 'compile and package without signing or installing')
    .option('--release', 'build an optimized application')
    .option('--no-web-build', 'use the existing web build output')
    .option('--clean', 'rebuild native products from scratch')
    .option('-o, --out <dir>', 'where to save the app and IPA');
}

wslProjectOptions(wsl.command('build').description('build and sign an iPhone app locally; save the app and IPA'))
  .action(wrap(wslBuildCommand));
wslProjectOptions(wsl.command('run').description('build, sign, install and launch on a USB-connected iPhone'))
  .option('-t, --target <udid>', 'which connected iPhone to use')
  .option('--no-logs', 'launch and return instead of streaming device logs')
  .action(wrap(wslRunCommand));
wslProjectOptions(wsl.command('dev').description('run on your iPhone with live reload from your Windows dev server'))
  .option('-t, --target <udid>', 'which connected iPhone to use')
  .option('--url <url>', 'dev-server URL reachable by your iPhone, e.g. http://192.168.1.20:5173')
  .option('--dev-command <cmd>', 'command that starts the dev server')
  .option('--live-host <host>', 'PC address reachable by the iPhone when starting a dev server')
  .option('--no-watch', 'do not rebuild automatically when native files change')
  .option('--no-logs', 'keep the development session running without streaming device logs')
  .action(wrap(wslDevCommand));

const apps = program
  .command('apps')
  .description('the apps in this folder (an iOS app and an Electron app, or the projects of a monorepo) and which one CapMac works on: list | use');
apps
  .command('list', { isDefault: true })
  .description('list the apps CapMac finds here, in the folders above and in the ones inside (no Mac needed)')
  .option('--json', 'machine-readable output')
  .action(wrap(appsCommand));
apps
  .command('use <app>')
  .description('work on this app from now on (ios or electron): capmac run, capmac dev and CapMac Studio use it')
  .action(wrap((app: string) => appsUseCommand(app)));

program
  .command('backend [where]')
  .description('where this project builds its iOS app: mac (a paired Mac) or wsl (this PC, no Mac); run, dev, build, doctor and CapMac Studio use it')
  .option('--json', 'machine-readable output')
  .action(wrap((where: string | undefined, options: { json?: boolean }) => backendCommand(where, options)));

program
  .command('info')
  .description('show what CapMac detected about this app and which files it would sync (no Mac needed)')
  .option('--files', 'list every file')
  .option('--live', 'as in live-reload mode (web assets left out)')
  .action(wrap(infoCommand));

program
  .command('targets')
  .description('list simulators and devices available on the Mac')
  .addOption(mac()).addOption(routeOption())
  .option('-e, --electron', "also list the Mac's desktop, where the Electron app runs")
  .option('--json', 'machine-readable output')
  .action(wrap(targetsCommand));

program
  .command('screen')
  .description("show the Mac's simulator in your browser, with touch and keyboard input (a plugged-in iPhone: its screen; an Electron app: its window)")
  .addOption(mac()).addOption(routeOption())
  .addOption(appOption())
  .option('-t, --target <name|udid>', 'simulator or device to show')
  .option('-d, --device', 'the iPhone or iPad plugged into the Mac with a cable (view only)')
  .option('-e, --electron', "the Electron app's window (it must be running)")
  .option('--port <port>', 'local port for the viewer (default 7373)')
  .option('--no-open', 'do not open the browser automatically')
  .addOption(soundOption())
  .addOption(streamOption())
  .action(wrap(screenCommand));

program
  .command('screenshot [file]')
  .description("save a PNG of the running simulator's screen, a plugged-in iPhone's, or the Electron app's window (default: a temp file; the path is printed)")
  .addOption(mac()).addOption(routeOption())
  .addOption(appOption())
  .option('-t, --target <name|udid>', 'simulator or device (default: the booted simulator this app last ran on)')
  .option('-d, --device', 'the iPhone or iPad plugged into the Mac with a cable')
  .option('-e, --electron', "the Electron app's window (it must be running)")
  .action(wrap((file: string | undefined, options) => screenshotCommand(file, options)));

program
  .command('dialog [answer]')
  .description("the running Electron app's message boxes and file dialogs: list them, or answer the oldest (a button's number or label, or a path on the Mac)")
  .addOption(mac()).addOption(routeOption())
  .option('--cancel', 'cancel it, as Escape or Cancel would')
  .option('--check', "tick (or untick) the message box's checkbox too")
  .option('--id <n>', 'answer this dialog instead of the oldest')
  .option('--json', 'machine-readable output')
  .action(wrap((answer: string | undefined, options) => dialogCommand(answer, options)));

program
  .command('logs')
  .description('stream the app\'s system log from a simulator')
  .addOption(mac()).addOption(routeOption())
  .option('-t, --target <name|udid>', 'simulator')
  .action(wrap(logsCommand));

program
  .command('sync')
  .description('sync the project to the Mac and run `cap sync` there')
  .addOption(mac()).addOption(routeOption())
  .option('--live', 'leave out the web build output')
  .option('--full', 'reinstall dependencies and run a full `cap sync`')
  .option('--no-prepare', 'only copy files')
  .action(wrap(syncCommand));

program
  .command('exec')
  .description('run a command inside the project on the Mac, e.g. `capmac exec -- pod update`')
  .addOption(mac()).addOption(routeOption())
  .addOption(new Option('--cwd <where>', 'working directory').choices(['project', 'root', 'ios']).default('project'))
  .option('--no-sync', 'do not sync first')
  .argument('<command...>')
  .action(wrap((command: string[], options) => execCommand(command, options)));

program
  .command('pull <paths...>')
  .description('copy files from the Mac back to this PC (e.g. `capmac pull ios` after `cap add ios` on the Mac)')
  .addOption(mac()).addOption(routeOption())
  .option('-y, --yes', 'overwrite without asking')
  .action(wrap((paths: string[], options) => pullCommand(paths, options)));

program.command('open').description('open the project in Xcode on the Mac').addOption(mac()).addOption(routeOption()).action(wrap(openXcodeCommand));

program
  .command('clean')
  .description('delete build products on the Mac (or the whole copy with --all)')
  .addOption(mac()).addOption(routeOption())
  .option('--all', 'remove the project from the Mac entirely')
  .action(wrap(cleanCommand));

program
  .command('keychain')
  .description('unlock the Mac\'s login keychain so code signing works over SSH')
  .addOption(mac()).addOption(routeOption())
  .option('--no-allow-codesign', 'only unlock; do not allow codesign to use keys without a prompt')
  .action(wrap(keychainCommand));

const remote = program
  .command('remote')
  .description('reach a Mac from anywhere, over the internet: status | on | off | set | server | pcs | revoke | test');
remote
  .command('status', { isDefault: true })
  .description('remote access for a Mac: its settings, the service on the Mac, and how CapMac connects')
  .addOption(mac())
  .addOption(routeOption())
  .option('--test', 'also connect over the internet now, and say how it went')
  .option('--json', 'machine-readable output')
  .action(wrap(remoteStatusCommand));
remote
  .command('on')
  .description('turn remote access on for a Mac (run it while this PC is on the Mac’s network)')
  .addOption(mac())
  .option('--signal-url <url>', 'your signaling server (wss://…); remembered for next time')
  .option('--keep-awake', 'keep the Mac awake while remote access is on')
  .action(wrap(remoteOnCommand));
remote
  .command('off')
  .description('turn remote access off: the Mac stops letting this PC in over the internet')
  .addOption(mac())
  .addOption(routeOption())
  .option('--local', 'only stop using it from this PC (when the Mac cannot be reached)')
  .action(wrap(remoteOffCommand));
remote
  .command('set')
  .description('change remote-access options for a Mac')
  .addOption(mac())
  .addOption(new Option('--route <how>', 'auto: the local network when the Mac answers there, else the internet; lan or internet: only that way').choices(ROUTE_CHOICES))
  .addOption(new Option('--relay <when>', 'allow: the relay when peer to peer is not possible; never; always (testing)').choices(RELAY_CHOICES))
  .option('--keep-awake <on|off>', 'keep the Mac awake while remote access is on')
  .option('--signal-url <url>', 'move this Mac to another signaling server')
  .action(wrap(remoteSetCommand));
remote
  .command('server [url]')
  .description('show or set your signaling server (used when remote access is turned on)')
  .option('--clear', 'forget the server setting')
  .option('--json', 'machine-readable output')
  .action(wrap(remoteServerCommand));
remote.command('pcs').description('list the PCs that can reach a Mac over the internet').addOption(mac()).addOption(routeOption()).option('--json', 'machine-readable output').action(wrap(remotePcsCommand));
remote
  .command('revoke <pc>')
  .description('stop letting another PC reach a Mac over the internet (its name or key: see `capmac remote pcs`)')
  .addOption(mac())
  .addOption(routeOption())
  .action(wrap((which: string, options) => remoteRevokeCommand(which, options)));
remote.command('test').description('connect to a Mac over the internet now, and say how').addOption(mac()).option('--json', 'machine-readable output').action(wrap(remoteTestCommand));

program
  .command('takeover [action]')
  .description('on | off | status: make `npx cap run ios` and `ionic cap run ios` run on the Mac')
  .action(wrap((action?: string) => takeoverCommand(action)));

const skill = program
  .command('skill')
  .description('teach AI coding agents (Claude Code, Codex, Copilot, Cursor, …) to use CapMac: status | add | remove | show');
const skillWhere = (cmd: Command) =>
  cmd
    .option('-a, --agent <ids...>', 'agents: claude-code, codex, copilot, cursor, gemini, windsurf, opencode, cline, kilo, amp, augment, goose, junie, or all')
    .option('-g, --global', "for all your projects (each agent's own folder)")
    .option('-p, --project [dir]', 'in a project (default: the one you are in), to commit for your team');
skillWhere(skill.command('status', { isDefault: true }).description('which agents have the CapMac skill, globally and in this project')).action(wrap(skillStatusCommand));
skillWhere(skill.command('add').alias('install').description('add (or update) the CapMac skill; asks which agents and where when run without options'))
  .option('--force', 'replace a "capmac" skill that CapMac did not write')
  .option('--command', 'also add the capmac command for new terminals if it is missing (agents run capmac)')
  .action(wrap(skillAddCommand));
skillWhere(skill.command('remove').alias('uninstall').description('remove the CapMac skill (only copies CapMac wrote)'))
  .option('--command', 'also remove the capmac command that CapMac added for new terminals')
  .action(wrap(skillRemoveCommand));
skill.command('show').description('print the skill (SKILL.md), to paste into any other agent').action(wrap(skillShowCommand));

// Registered for --help only: Capacitor's own options are read by capCommand, below.
program
  .command('cap')
  .description('run `cap run ios`, `cap open ios` or `cap build ios` on the Mac, with the same options as Capacitor')
  .argument('<args...>');

const [first, ...rest] = process.argv.slice(2);
if (first === 'cap') {
  if (rest.includes('--verbose')) setVerbose(true);
  void wrap(capCommand)(rest.filter((a) => a !== '--verbose'));
} else {
  program.parseAsync(process.argv).catch((err) => {
    reportError(err);
    process.exitCode = 1;
  });
}
