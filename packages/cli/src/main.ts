import { Command, Option } from 'commander';
import { buildCommand } from './commands/build.js';
import { devCommand } from './commands/dev.js';
import { doctorCommand } from './commands/doctor.js';
import { macsCommand, pairCommand, setDefaultCommand, unpairCommand } from './commands/pair.js';
import { runCommand } from './commands/run.js';
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
  .description('Pair to Mac for Capacitor: build, run, live-reload and see your iOS app on a Mac, from Windows.')
  .version(VERSION, '-V, --version')
  .option('-v, --verbose', 'show full tool output')
  .showHelpAfterError()
  .hook('preAction', (cmd) => {
    if (cmd.opts().verbose || cmd.optsWithGlobals?.().verbose) setVerbose(true);
  });

const mac = () => new Option('--mac <name>', 'which paired Mac to use');

function targetOptions(cmd: Command): Command {
  return cmd
    .option('-t, --target <name|udid>', 'simulator or device to use (see `capmac targets`)')
    .option('-d, --device', 'run on a connected iPhone/iPad instead of a simulator')
    .option('-s, --simulator', 'only consider simulators');
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
  .option('--identity <file>', 'use this private key instead of capmac\'s own')
  .option('--agent', 'authenticate with the Windows OpenSSH agent')
  .option('--password-env <var>', 'read the Mac password from this environment variable (CI)')
  .option('-y, --yes', 'trust the host key and install Node.js without asking')
  .option('--default', 'make this the default Mac')
  .action(wrap(pairCommand));

program.command('macs').description('list paired Macs').action(wrap(macsCommand));
program.command('use <name>').description('make a paired Mac the default').action(wrap(setDefaultCommand));
program.command('unpair <name>').description('forget a paired Mac').action(wrap(unpairCommand));

program
  .command('doctor')
  .description('check this PC, the connection and the Mac (Xcode, simulators, Node, CocoaPods…)')
  .addOption(mac())
  .option('--fix', 'fix what can be fixed (license, Node.js, iOS platform, AXe…)')
  .option('-y, --yes', 'do not ask before fixing')
  .action(wrap(doctorCommand));

buildOptions(targetOptions(
  program
    .command('run')
    .description('build the web app, sync, build on the Mac and launch on a simulator or device')
    .addOption(mac())
    .option('--release', 'shortcut for --configuration Release')
    .option('--no-web-build', 'do not run the web build first (use the existing web dir)')
    .option('--no-logs', 'launch and return instead of streaming app logs')
    .option('--show-simulator', 'also open the Simulator window on the Mac\'s screen')
    .option('--os-logs', 'also show NSLog/os_log output, like Xcode\'s console')
    .option('--bridge', 'show Capacitor bridge traffic in the logs'),
)).action(wrap(runCommand));

buildOptions(targetOptions(
  program
    .command('dev')
    .description('live reload: your dev server runs here, the app on the Mac loads it through an SSH tunnel')
    .addOption(mac())
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
    .addOption(mac())
    .option('--release', 'shortcut for --configuration Release')
    .option('--no-web-build', 'do not run the web build first')
    .option('--ipa', 'archive and export an .ipa, then download it')
    .option('--export <type>', 'export type: development | ad-hoc | app-store | enterprise')
    .option('--upload', 'archive and upload to App Store Connect / TestFlight')
    .option('-o, --out <dir>', 'where to save the .ipa (default: build/ios)'),
)).action(wrap(buildCommand));

program
  .command('info')
  .description('show what capmac detected about this app and which files it would sync (no Mac needed)')
  .option('--files', 'list every file')
  .option('--live', 'as in live-reload mode (web assets left out)')
  .action(wrap(infoCommand));

program
  .command('targets')
  .description('list simulators and devices available on the Mac')
  .addOption(mac())
  .option('--json', 'machine-readable output')
  .action(wrap(targetsCommand));

program
  .command('screen')
  .description('show the Mac\'s simulator in your browser, with touch and keyboard input')
  .addOption(mac())
  .option('-t, --target <name|udid>', 'simulator to show')
  .option('--port <port>', 'local port for the viewer (default 7373)')
  .option('--no-open', 'do not open the browser automatically')
  .action(wrap(screenCommand));

program
  .command('logs')
  .description('stream the app\'s system log from a simulator')
  .addOption(mac())
  .option('-t, --target <name|udid>', 'simulator')
  .action(wrap(logsCommand));

program
  .command('sync')
  .description('sync the project to the Mac and run `cap sync` there')
  .addOption(mac())
  .option('--live', 'leave out the web build output')
  .option('--full', 'reinstall dependencies and run a full `cap sync`')
  .option('--no-prepare', 'only copy files')
  .action(wrap(syncCommand));

program
  .command('exec')
  .description('run a command inside the project on the Mac, e.g. `capmac exec -- pod update`')
  .addOption(mac())
  .addOption(new Option('--cwd <where>', 'working directory').choices(['project', 'root', 'ios']).default('project'))
  .option('--no-sync', 'do not sync first')
  .argument('<command...>')
  .action(wrap((command: string[], options) => execCommand(command, options)));

program
  .command('pull <paths...>')
  .description('copy files from the Mac back to this PC (e.g. `capmac pull ios` after `cap add ios` on the Mac)')
  .addOption(mac())
  .option('-y, --yes', 'overwrite without asking')
  .action(wrap((paths: string[], options) => pullCommand(paths, options)));

program.command('open').description('open the project in Xcode on the Mac').addOption(mac()).action(wrap(openXcodeCommand));

program
  .command('clean')
  .description('delete build products on the Mac (or the whole copy with --all)')
  .addOption(mac())
  .option('--all', 'remove the project from the Mac entirely')
  .action(wrap(cleanCommand));

program
  .command('keychain')
  .description('unlock the Mac\'s login keychain so code signing works over SSH')
  .addOption(mac())
  .option('--no-allow-codesign', 'only unlock; do not allow codesign to use keys without a prompt')
  .action(wrap(keychainCommand));

program.parseAsync(process.argv).catch((err) => {
  reportError(err);
  process.exitCode = 1;
});
