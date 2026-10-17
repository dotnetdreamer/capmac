/**
 * The capmac skill: what an AI coding agent (Claude Code, Codex, Copilot, …)
 * needs to know to build, run and check a Capacitor app's iOS side, a Flutter or React Native
 * app, or an Electron app on the Mac, with the capmac CLI. Agent Skills format (agentskills.io): SKILL.md stays short; the
 * full command list is in references/, read only when needed.
 */

export const SKILL_NAME = 'capmac';

/** First line after the frontmatter: tells an installed copy's version (and that capmac wrote it). */
export const SKILL_MARKER = 'capmac-skill-version:';

const DESCRIPTION =
  'Build, run and check the iOS side of a Capacitor or Ionic app, a Flutter or React Native app (iOS, Mac and Windows), or an Electron app, from Windows, on a Mac paired with the CapMac CLI. ' +
  'Use when asked to run or test an app on an iOS simulator or iPhone, a Flutter, React Native or Electron app on a Mac, read its console logs, take a screenshot of it, ' +
  'fix Xcode, Swift, Dart or JavaScript build errors, export an .ipa, or when `npx cap run ios` or `ionic capacitor run ios` comes up on Windows.';

function skillMd(version: string): string {
  return `---
name: ${SKILL_NAME}
description: ${DESCRIPTION}
---
<!-- ${SKILL_MARKER} ${version} -->

# CapMac: iOS for Capacitor, Flutter and React Native apps, and Mac apps, from Windows

CapMac drives a Mac over SSH. It syncs the project, builds it with Xcode on the Mac, runs the app on a simulator or iPhone, and brings build errors, console logs and screenshots back to this PC. It runs Flutter, React Native and Electron apps the same way (see below). Run every command from the app's folder (the one with \`capacitor.config.*\`, a Flutter app's \`pubspec.yaml\`, or a React Native or Electron app's \`package.json\`). Edit files on this PC only: the Mac's copy is overwritten on every sync.

## First, check the setup

\`\`\`
capmac doctor
\`\`\`

If the shell can't find \`capmac\`, stop and tell the user: the command comes with CapMac for VS Code (in VS Code's terminals and agents) and CapMac Studio, or installs with \`npm install -g capmac\`. If it reports that no Mac is paired, stop and ask the user to run \`capmac pair\` in their own terminal. Pairing needs the Mac's password, which you must never ask for or type. \`capmac info\` shows what CapMac detected about the app (app id, web folder, iOS project) without contacting the Mac. A folder can hold more than one app (a Capacitor project's iOS app and its Electron platform, or the apps of a monorepo): \`capmac apps\` lists them and the one CapMac uses, which the user may have picked in CapMac Studio. Add \`--app ios\` or \`--app electron\` to be sure which one a command is for.

## Commands that finish on their own

| Goal | Command |
|---|---|
| Build the web app, build on the Mac, launch on a simulator, return once it runs | \`capmac run --no-logs\` |
| The same, then show the app's console for 20 seconds and stop the app | \`capmac run --for 20\` |
| See the screen (a PNG path is printed; open the image to look at it) | \`capmac screenshot\` |
| List simulators and devices | \`capmac targets --json\` |
| Choose one | add \`--target "iPhone 17 Pro"\` (a name or UDID) to \`run\`, \`build\` or \`screenshot\` |
| Check that it compiles, without launching | \`capmac build\` |
| Run any command in the project on the Mac | \`capmac exec -- pod --version\` |
| Copy a file from the Mac's copy back to this PC | \`capmac pull <path> -y\` |

A typical check after changing code: \`capmac run --for 15\`, read the console for errors, then \`capmac run --no-logs\` and \`capmac screenshot\` to look at the result. Web-only changes skip Xcode and reinstall in seconds. The first run of a project takes about a minute (npm install and Swift packages on the Mac).

## Commands that keep running

\`capmac run\` (without \`--no-logs\` or \`--for\`), \`capmac dev\` (live reload), \`capmac logs\` and \`capmac screen\` run until they are stopped. Start them only as a background process that you can read and stop. Otherwise use the commands above.

## Electron apps

In an Electron app's folder (plain Electron, electron-vite or Electron Forge), the same commands run the app on the Mac's desktop: \`capmac run --for 20\` or \`capmac run --no-logs\`, then \`capmac screenshot --electron\` for a PNG of its window. In a Capacitor project, add \`--app electron\` (or \`--electron\`) to use its Electron platform instead of iOS; \`capmac apps use electron\` makes that the default, in CapMac Studio too. Console lines start with \`main\` (the main process) or \`js\` (the pages). The app opens behind the windows of whoever is using the Mac and never takes their keyboard, so running it does not disturb them. If the app opens a message box or file dialog, the console prints it and the app waits: answer it with \`capmac dialog <button number or label>\`, \`capmac dialog \"~/path/on/the/mac\"\` or \`capmac dialog --cancel\` (\`capmac dialog\` alone lists what is open). The app's sound is off unless \`--sound mac\` (the Mac's speakers) or \`--sound pc\` (the browser viewer) is given; the choice is remembered for the project. \`capmac screen --electron\` shows the window in the browser as video, which needs far less data; \`--stream compatible\` sends pictures instead (for an old Electron or a browser without WebCodecs), and CapMac Studio uses the same choice.

## Flutter apps

In a Flutter app's folder, \`capmac run --for 20\` runs its iOS app in a simulator on the Mac (Flutter builds it there with \`flutter run\`; CapMac installs Flutter on the Mac the first time). \`--app mac\` runs its Mac app on the Mac's desktop (\`capmac screenshot --app mac\` takes a PNG of its window), and \`--app windows\` its Windows app on this PC, with no Mac. \`--mode profile\` or \`--mode release\` builds as people get it; \`--flavor\`, \`--main <file>\` and \`--dart-define KEY=VALUE\` are Flutter's own options. \`capmac dev\` hot-reloads the app on every save of Dart code (a hot restart when the change needs one); a change to \`pubspec.yaml\` or native code rebuilds it. Console lines start with \`dart\` (the app's \`print\`) or \`app\` (the engine and plugins). Dart compile errors use this PC's paths, \`C:\\path\\to\\lib\\main.dart:12:5: Error: …\`.

## React Native apps

In a React Native (or Expo) app's folder, \`capmac run --for 20\` runs its iOS app in a simulator on the Mac: Metro starts on this PC, the Mac installs the packages, runs \`pod install\` and builds the app only when something native changed, and the app loads its JavaScript from Metro on this PC. \`--app mac\` runs its Mac app (react-native-macos) on the Mac's desktop (\`capmac screenshot --app mac\` takes a PNG of its window), and \`--app windows\` its Windows app (react-native-windows) on this PC, with no Mac. \`--release\` builds the JavaScript into the app instead (no Metro). \`capmac dev\` keeps Metro running: every save shows in the app at once (Fast Refresh, no build); \`r\` reloads the JavaScript, \`j\` opens React Native DevTools, and a change to \`package.json\`, a Podfile or native code rebuilds the app. Console lines start with \`js\` (the app's \`console.log\`, handed over by Metro) or \`app\` (native logs); JavaScript errors give this PC's file and line. An Expo app without an \`ios\` folder gets one from \`expo prebuild\` on the first run.

## Building without a Mac

A project can build on this PC instead, in WSL with no Mac: \`capmac backend\` says which one it uses (the user may have picked it in CapMac Studio), and \`capmac run\`, \`dev\`, \`build\` and \`doctor\` follow it. There the app runs on an iPhone plugged into this PC, not a simulator: \`capmac wsl targets --json\` lists it, and \`capmac doctor\` checks the build tools, the iPhone SDK and signing. Add \`--backend mac\` or \`--backend wsl\` to be sure where one command builds.

## Reading the output

- Exit code 0 means success. A failure prints \`✖ what went wrong\`, then \`→ how to fix it\`. Follow that hint.
- Xcode and Swift errors use this PC's paths, \`C:\\path\\to\\File.swift:12:9: error: …\`. Fix those files here and run again.
- Console lines start with \`js\` (the web app's \`console.*\`), \`cap\` (Capacitor) or \`ios\` (native). Add \`--os-logs\` for NSLog/os_log, or \`--verbose\` for the full xcodebuild and npm output.

## Capacitor and Ionic commands

With CapMac's takeover on (check with \`capmac takeover\`), \`npx cap run ios\`, \`npx cap run ios --list\`, \`ionic capacitor run ios\`, \`npx cap open ios\` and \`npx cap build ios\` also run through CapMac. \`cap sync\`, \`cap copy\`, \`cap add\` and Android stay on this PC. Prefer the \`capmac\` commands above: their options are made for this.

## When the Mac is far away

With remote access on, CapMac reaches the Mac over the internet when it is not on this network, and every command works the same (a little slower). \`capmac remote status\` says how it connects. If a command reports the Mac offline, it is asleep or logged out: tell the user.

## Leave these to the user

- Anything that needs the Mac's password or a hand on a device: \`capmac pair\`, \`capmac keychain\` (unlocks code signing for iPhones and .ipa exports), \`capmac doctor --fix\` when it asks for a password, plugging in an iPhone and tapping Trust.
- \`capmac wsl setup\`: it signs in to Apple with the user's password and a two-factor code, which you must never ask for or type.
- Ask before you run \`capmac clean --all\` (deletes the project's copy on the Mac), \`capmac unpair\`, \`capmac takeover off\`, or a \`capmac remote\` command that changes settings (\`on\`, \`off\`, \`set\`, \`server\`, \`revoke\`).

Every command and option is listed in [references/commands.md](references/commands.md).
`;
}

const COMMANDS_MD = `# capmac commands

Every command accepts \`--mac <name>\` (which paired Mac) and \`--verbose\`; the ones that talk to the Mac also take \`--route auto|lan|internet\` (how to reach it this time). Options can also be set per project in \`capmac.json\`, next to \`capacitor.config.*\` (or an Electron app's \`package.json\`):

\`\`\`json
{ "host": "studio", "ios": { "target": "iPhone 17 Pro", "team": "ABCDE12345", "scheme": "App" }, "web": { "build": "npm run build", "dev": "npm run dev" } }
\`\`\`

An Electron app's commands go in \`"electron": { "build": "npm run build", "start": "npm start", "dev": "npm run dev" }\`, with \`"dir"\` for a Capacitor project's Electron platform folder (\`electron\` by default).

## Running

| Command | What it does |
|---|---|
| \`capmac run\` | Web build, sync, \`npm install\` and \`cap sync\` on the Mac when needed, xcodebuild, install, launch, then stream the app's console until stopped. |
| \`capmac run --no-logs\` | Same, but returns as soon as the app is running (it keeps running). |
| \`capmac run --for <seconds>\` | Same, streams the console for that long once the app runs, then stops the app and exits 0. |
| \`capmac dev\` | Live reload: starts the dev server (\`dev\`/\`start\` script, or \`--url\` for a running one), tunnels it to the Mac and rebuilds on native changes. Runs until stopped. |
| \`capmac build\` | Builds on the Mac without launching. |
| \`capmac build --ipa --export <development\\|ad-hoc\\|app-store\\|enterprise>\` | Archives and exports a signed .ipa to \`build/ios/\` (\`-o\` to change). Needs signing set up by the user. |
| \`capmac build --upload\` | Uploads to App Store Connect / TestFlight. Ask the user first. |

Options shared by \`run\`, \`dev\` and \`build\`:

| Option | Meaning |
|---|---|
| \`-a, --app <ios\\|electron\\|mac\\|windows>\` | Which of the project's apps (see \`capmac apps\`); \`mac\` and \`windows\` are a Flutter or React Native app's; default: the one picked with \`capmac apps use\` or in CapMac Studio. |
| \`-t, --target <name\\|udid>\` | Simulator or device (see \`capmac targets\`); \`mac\` for the Mac's desktop, \`pc\` for this PC (a Flutter or React Native app's Windows app). |
| \`--mode <debug\\|profile\\|release>\`, \`--flavor <name>\`, \`--main <file>\`, \`--dart-define K=V\` | A Flutter app's build options. |
| \`-e, --electron\` | The Electron app, on the Mac's desktop (needed only in a Capacitor project that has iOS too). |
| \`-d, --device\` | A connected iPhone/iPad instead of a simulator. |
| \`-c, --configuration <name>\` / \`--release\` | Xcode configuration (Debug by default). |
| \`--scheme <name>\` | Xcode scheme (App by default). |
| \`--team <id>\` | Apple Developer Team ID, for devices. |
| \`--clean\` | Clean build. |
| \`--full\` | Reinstall node_modules on the Mac and run a full \`cap sync\`. |
| \`--no-web-build\` | Use the web folder as it is (\`run\` and \`build\`). |
| \`--all-warnings\` | Also show warnings from Pods and Swift packages. |
| \`--xcodebuild-arg <arg>\` | Extra xcodebuild argument (repeatable). |
| \`--api-key <file.p8> --api-issuer <id>\` | App Store Connect API key, so device builds can sign over SSH. |
| \`--os-logs\`, \`--bridge\` | Also show NSLog/os_log, or Capacitor bridge calls, in the console. |

## Looking at the app

| Command | What it does |
|---|---|
| \`capmac screenshot [file] [-t <simulator>]\` | Saves a PNG of a running simulator and prints its path (a temp file unless you give one). |
| \`capmac screenshot --device [file]\` | The same for the iPhone plugged into the Mac with a cable, at its full size. The first time, someone has to click Allow on the Mac. |
| \`capmac screenshot --electron [file]\` | The same for the running Electron app's window. |
| \`capmac dialog [answer] [--cancel] [--check] [--json]\` | The running Electron app's open dialogs, or an answer to the oldest: a button's number or label, or a path on the Mac. |
| \`capmac logs [-t <simulator>]\` | Streams the app's system log. Runs until stopped. |
| \`capmac screen [--electron] [--device]\` | The simulator, the Electron app's window, or a plugged-in iPhone's screen (view only), in a browser (for people, not agents). |
| \`capmac targets [--json] [--electron]\` | Simulators and devices on the Mac, with their state; \`--electron\` adds the Mac's desktop. |

## The Mac and the project

| Command | What it does |
|---|---|
| \`capmac doctor [--fix] [-y]\` | Checks this PC, the connection and the Mac; \`--fix\` repairs what it can (may ask for the Mac password). |
| \`capmac info [--files]\` | What CapMac detected and which files it syncs. No Mac needed. |
| \`capmac apps [--json]\` | The apps in this folder (and in the folders inside it) and the one CapMac uses; \`capmac apps use <app>\` changes it. No Mac needed. |
| \`capmac backend [mac\\|wsl] [--json]\` | Where the project's iOS app builds: a paired Mac, or this PC with no Mac (WSL). With a name, picks it for \`run\`, \`dev\`, \`build\`, \`doctor\` and CapMac Studio (ask first). |
| \`capmac wsl setup\\|doctor\\|targets\\|build\\|run\\|dev\` | Building on this PC: setup (Apple sign-in, so the user runs it), its checks, iPhones plugged into this PC, and the same build, run and live reload. |
| \`capmac sync [--full]\` | Syncs files and runs \`cap sync\` on the Mac. |
| \`capmac exec [--no-sync] [--cwd project\\|root\\|ios] -- <command>\` | Runs a command in the project on the Mac and prints its output. |
| \`capmac pull <paths…> [-y]\` | Copies files from the Mac's copy back to this PC. |
| \`capmac open\` | Opens the project in Xcode on the Mac's screen. |
| \`capmac clean [--all]\` | Deletes build products on the Mac; \`--all\` removes the whole copy (ask first). |
| \`capmac macs\`, \`capmac use <name>\` | Lists paired Macs, picks the default. |
| \`capmac pair\`, \`capmac unpair <name>\`, \`capmac keychain\` | Need the user: passwords and trust decisions. |
| \`capmac takeover [on\\|off]\` | Whether \`npx cap run ios\` and \`ionic capacitor run ios\` go through CapMac. |
| \`capmac cap <capacitor arguments>\` | Runs \`cap run ios\`, \`cap open ios\` or \`cap build ios\` with Capacitor's own options. |

## Remote access (the Mac over the internet)

| Command | What it does |
|---|---|
| \`capmac remote [status] [--test] [--json]\` | Whether remote access is on, its settings, the service on the Mac, and how CapMac connects; \`--test\` also connects over the internet. |
| \`capmac remote test [--json]\` | Connects over the internet now and says how: peer to peer, or through the relay. |
| \`capmac remote pcs [--json]\` | The PCs that can reach the Mac over the internet. |
| \`capmac remote on\`, \`off\`, \`set\`, \`server\`, \`revoke\` | Change remote access. Ask the user first. |
`;

/** The files of the capmac skill folder, by path relative to it. */
export function skillFiles(version: string): Record<string, string> {
  return {
    'SKILL.md': skillMd(version),
    'references/commands.md': COMMANDS_MD,
  };
}
