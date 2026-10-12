/**
 * The capmac skill: what an AI coding agent (Claude Code, Codex, Copilot, …)
 * needs to know to build, run and check a Capacitor app's iOS side with the
 * capmac CLI. Agent Skills format (agentskills.io): SKILL.md stays short; the
 * full command list is in references/, read only when needed.
 */

export const SKILL_NAME = 'capmac';

/** First line after the frontmatter: tells an installed copy's version (and that capmac wrote it). */
export const SKILL_MARKER = 'capmac-skill-version:';

const DESCRIPTION =
  'Build, run and check the iOS side of a Capacitor or Ionic app from Windows, on a Mac paired with the CapMac CLI. ' +
  'Use when asked to run or test an app on an iOS simulator or iPhone, read its console logs, take a screenshot of it, ' +
  'fix Xcode or Swift build errors, export an .ipa, or when `npx cap run ios` or `ionic capacitor run ios` comes up on Windows.';

function skillMd(version: string): string {
  return `---
name: ${SKILL_NAME}
description: ${DESCRIPTION}
---
<!-- ${SKILL_MARKER} ${version} -->

# CapMac: iOS for Capacitor apps, from Windows

CapMac drives a Mac over SSH. It syncs the project, builds it with Xcode on the Mac, runs the app on a simulator or iPhone, and brings build errors, console logs and screenshots back to this PC. Run every command from the app's folder (the one with \`capacitor.config.*\`). Edit files on this PC only: the Mac's copy is overwritten on every sync.

## First, check the setup

\`\`\`
capmac doctor
\`\`\`

If it reports that no Mac is paired, stop and ask the user to run \`capmac pair\` in their own terminal. Pairing needs the Mac's password, which you must never ask for or type. \`capmac info\` shows what CapMac detected about the app (app id, web folder, iOS project) without contacting the Mac.

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

## Reading the output

- Exit code 0 means success. A failure prints \`✖ what went wrong\`, then \`→ how to fix it\`. Follow that hint.
- Xcode and Swift errors use this PC's paths, \`C:\\path\\to\\File.swift:12:9: error: …\`. Fix those files here and run again.
- Console lines start with \`js\` (the web app's \`console.*\`), \`cap\` (Capacitor) or \`ios\` (native). Add \`--os-logs\` for NSLog/os_log, or \`--verbose\` for the full xcodebuild and npm output.

## Capacitor and Ionic commands

With CapMac's takeover on (check with \`capmac takeover\`), \`npx cap run ios\`, \`npx cap run ios --list\`, \`ionic capacitor run ios\`, \`npx cap open ios\` and \`npx cap build ios\` also run through CapMac. \`cap sync\`, \`cap copy\`, \`cap add\` and Android stay on this PC. Prefer the \`capmac\` commands above: their options are made for this.

## Leave these to the user

- Anything that needs the Mac's password or a hand on a device: \`capmac pair\`, \`capmac keychain\` (unlocks code signing for iPhones and .ipa exports), \`capmac doctor --fix\` when it asks for a password, plugging in an iPhone and tapping Trust.
- Ask before you run \`capmac clean --all\` (deletes the project's copy on the Mac), \`capmac unpair\` or \`capmac takeover off\`.

Every command and option is listed in [references/commands.md](references/commands.md).
`;
}

const COMMANDS_MD = `# capmac commands

Every command accepts \`--mac <name>\` (which paired Mac) and \`--verbose\`. Options can also be set per project in \`capmac.json\`, next to \`capacitor.config.*\`:

\`\`\`json
{ "host": "studio", "ios": { "target": "iPhone 17 Pro", "team": "ABCDE12345", "scheme": "App" }, "web": { "build": "npm run build", "dev": "npm run dev" } }
\`\`\`

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
| \`-t, --target <name\\|udid>\` | Simulator or device (see \`capmac targets\`). |
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
| \`capmac logs [-t <simulator>]\` | Streams the app's system log. Runs until stopped. |
| \`capmac screen\` | The simulator in a browser, with touch input (for people, not agents). |
| \`capmac targets [--json]\` | Simulators and devices on the Mac, with their state. |

## The Mac and the project

| Command | What it does |
|---|---|
| \`capmac doctor [--fix] [-y]\` | Checks this PC, the connection and the Mac; \`--fix\` repairs what it can (may ask for the Mac password). |
| \`capmac info [--files]\` | What CapMac detected and which files it syncs. No Mac needed. |
| \`capmac sync [--full]\` | Syncs files and runs \`cap sync\` on the Mac. |
| \`capmac exec [--no-sync] [--cwd project\\|root\\|ios] -- <command>\` | Runs a command in the project on the Mac and prints its output. |
| \`capmac pull <paths…> [-y]\` | Copies files from the Mac's copy back to this PC. |
| \`capmac open\` | Opens the project in Xcode on the Mac's screen. |
| \`capmac clean [--all]\` | Deletes build products on the Mac; \`--all\` removes the whole copy (ask first). |
| \`capmac macs\`, \`capmac use <name>\` | Lists paired Macs, picks the default. |
| \`capmac pair\`, \`capmac unpair <name>\`, \`capmac keychain\` | Need the user: passwords and trust decisions. |
| \`capmac takeover [on\\|off]\` | Whether \`npx cap run ios\` and \`ionic capacitor run ios\` go through CapMac. |
| \`capmac cap <capacitor arguments>\` | Runs \`cap run ios\`, \`cap open ios\` or \`cap build ios\` with Capacitor's own options. |
`;

/** The files of the capmac skill folder, by path relative to it. */
export function skillFiles(version: string): Record<string, string> {
  return {
    'SKILL.md': skillMd(version),
    'references/commands.md': COMMANDS_MD,
  };
}
