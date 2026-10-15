import { Command, Option } from 'commander';
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

const program = new Command();
program
  .name('capmac')
  .description('Pair to Mac for Capacitor and Electron: build, run, live-reload and see your iOS app, or your Electron app, on a Mac, from Windows.')
  .version(VERSION, '-V, --version')
  .option('-v, --verbose', 'show full tool output')
  .showHelpAfterError()
  .hook('preAction', async (cmd, action) => {
    if (cmd.opts().verbose || cmd.optsWithGlobals?.().verbose) setVerbose(true);
    // --route is "this time" everywhere except `capmac remote set`, where it is the Mac's setting.
    const route = action.opts().route as RouteChoice | undefined;
    if (route && !(action.name() === 'set' && action.parent?.name() === 'remote')) setRouteOverride(route);
    // Takeover is on by default: the first capmac command (usually `capmac pair`) turns it on.
    if (action.name() !== 'takeover') await takeoverByDefault();
  });

const mac = () => new Option('--mac <name>', 'which paired Mac to use');
const routeOption = () => new Option('--route <how>', 'how to reach the Mac this time (default: its remote-access setting)').choices(ROUTE_CHOICES);

function targetOptions(cmd: Command): Command {
  return cmd
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

program
  .command('doctor')
  .description('check this PC, the connection and the Mac (Xcode, simulators, Node, CocoaPods…)')
  .addOption(mac()).addOption(routeOption())
  .option('--fix', 'fix what can be fixed (license, Node.js, iOS platform, AXe…)')
  .option('-y, --yes', 'do not ask before fixing')
  .action(wrap(doctorCommand));

buildOptions(targetOptions(
  program
    .command('run')
    .description("build the web app, sync, build on the Mac and launch on a simulator or device (an Electron app: on the Mac's desktop)")
    .addOption(mac()).addOption(routeOption())
    .option('--release', 'shortcut for --configuration Release')
    .option('--no-web-build', 'do not run the web build first (use the existing web dir)')
    .option('--no-logs', 'launch and return instead of streaming app logs')
    .option('--for <seconds>', "stream the app's console for this long, then stop (scripts, AI agents)")
    .option('--show-simulator', 'also open the Simulator window on the Mac\'s screen')
    .option('--os-logs', 'also show NSLog/os_log output, like Xcode\'s console')
    .option('--bridge', 'show Capacitor bridge traffic in the logs'),
)).action(wrap(runCommand));

buildOptions(targetOptions(
  program
    .command('dev')
    .description('live reload: your dev server runs here, the app on the Mac loads it through an SSH tunnel (an Electron app reloads on the Mac as you save)')
    .addOption(mac()).addOption(routeOption())
    .option('--url <url>', 'use an already running dev server (e.g. http://localhost:5173)')
    .option('--dev-command <cmd>', 'command that starts the dev server (default: the "dev"/"start" script)')
    .option('--screen', 'open the remote simulator screen in your browser')
    .option('--no-watch', 'do not rebuild automatically when native files change')
    .option('--show-simulator', 'also open the Simulator window on the Mac\'s screen')
    .option('--os-logs', 'also show NSLog/os_log output, like Xcode\'s console')
    .option('--bridge', 'show Capacitor bridge traffic in the logs'),
)).action(wrap(devCommand));

buildOptions(targetOptions(
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
)).action(wrap(buildCommand));

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
  .description("show the Mac's simulator in your browser, with touch and keyboard input (an Electron app: its window)")
  .addOption(mac()).addOption(routeOption())
  .option('-t, --target <name|udid>', 'simulator to show')
  .option('-e, --electron', "the Electron app's window (it must be running)")
  .option('--port <port>', 'local port for the viewer (default 7373)')
  .option('--no-open', 'do not open the browser automatically')
  .action(wrap(screenCommand));

program
  .command('screenshot [file]')
  .description("save a PNG of the running simulator's screen, or the Electron app's window (default: a temp file; the path is printed)")
  .addOption(mac()).addOption(routeOption())
  .option('-t, --target <name|udid>', 'simulator (default: the booted one this app last ran on)')
  .option('-e, --electron', "the Electron app's window (it must be running)")
  .action(wrap((file: string | undefined, options) => screenshotCommand(file, options)));

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
