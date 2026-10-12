# CapMac — Pair to Mac for Capacitor

Develop your Capacitor app on **Windows**, and let a **Mac** on your network do the iOS part: build with Xcode, run on the simulator or an iPhone, stream the logs back, live-reload from your Windows dev server, and even show the simulator in your browser. It's what Xamarin's *Pair to Mac* did, for Capacitor.

```
Windows (your editor, dev server)                          Mac (Xcode)
┌──────────────────────────────┐   one SSH connection   ┌─────────────────────────────────┐
│ capmac CLI                   │ ─────────────────────► │ capmac agent (uploaded on demand)│
│  • syncs only changed files  │   files, commands,     │  • npm install, npx cap sync     │
│  • shows build errors with   │ ◄───────────────────── │  • xcodebuild                    │
│    clickable Windows paths   │   logs, screen frames  │  • simctl / devicectl            │
│  • Vite/Angular dev server ◄─┼── reverse tunnel ──────┼─ app's WebView loads it          │
└──────────────────────────────┘                        └─────────────────────────────────┘
```

## CapMac Studio, the Windows app

The same engine with a window around it. Pair your Mac in a few clicks, add your Capacitor app, and press **Live** (F5) or **Run** (Ctrl+F5). You get:

- every build step on a timeline;
- build errors as problems you click to open at the line in your editor;
- your app's console with source and level filters, search, and JSON you can expand;
- the iOS simulator, live, next to your code: up to 60 frames a second, about 15 ms behind the Mac on a home network. Click and drag to touch, scroll with the wheel or touchpad, type on your PC's keyboard, paste, and press Home or Lock.

If the connection to the Mac drops, it reconnects and restores the session. Ctrl+K finds any command.

The simulator streams as H.264 from its framebuffer through a small helper that CapMac compiles on the Mac, with your Xcode, the first time you open a simulator. The same helper sends touches and keys, so AXe is not needed. If the smooth stream cannot run, the pane switches to screenshots (the *compatible* stream) by itself and says why. Settings › Appearance › Simulator stream chooses between the two.

`npm run desktop:build` builds it into `apps/desktop/release/<version>/`:

- `capmac-studio-<version>-x64-setup.exe`, a per-user installer;
- `capmac-studio-<version>-x64-portable.exe`, which needs no installation;
- the same two for arm64.

Builds are unsigned and don't update themselves until you set a few environment variables: Azure Artifact Signing or a code signing certificate, and `CAPMAC_UPDATE_URL`, the HTTPS folder installed copies check for new versions. Then installed copies update in the background and install on restart, without interrupting a running app. [docs/signing-and-updates.md](docs/signing-and-updates.md) has the options, their costs, and how to publish an update.

The design (screens, visual language, architecture, simulator streaming) is in [docs/desktop-design.md](docs/desktop-design.md).

## Quick start

**On the Mac (once):** install Xcode and open it once, then turn on **System Settings › General › Sharing › Remote Login**. Stay logged in to the Mac's desktop (or enable automatic login on a headless Mac): Apple's simulators only run inside a desktop session.

**On Windows:**

```powershell
npm install -g capmac            # or: npx capmac …
capmac pair                      # finds your Mac, asks its password once, installs a key
cd my-capacitor-app
capmac run                       # build web → sync → build on the Mac → launch → stream logs
capmac dev                       # live reload: save in VS Code, the simulator updates instantly
```

`capmac pair` only needs your Mac password once: it installs a dedicated SSH key (`%USERPROFILE%\.capmac\id_ed25519`) and pins the Mac's host key. Node.js on the Mac is optional — if it's missing, CapMac offers to install a private copy in `~/.capmac/runtime` (no sudo, nothing system-wide).

**Measured** on an M1 Mac (macOS 26.6, Xcode 26.6) over Wi-Fi with Capacitor 8.5 apps (Swift Package Manager and CocoaPods):

| | |
|---|---|
| First `capmac run` (npm install, `cap sync`, Swift packages, simulator boot) | ~50 s |
| `capmac run` again, nothing changed | ~6 s |
| Web-only change (no Xcode build) | ~5 s |
| Native (Swift) change, incremental build | ~10 s |
| `capmac dev`: save a file → app reloads | ~1 s |

## Keep your Capacitor and Ionic commands

Your team already types `npx cap run ios` or `ionic capacitor run ios -l`. With CapMac installed, those same commands run on the Mac. Nobody has to learn `capmac run`.

This "takeover" is **on by default**. The first capmac command you run (usually `capmac pair`), or the first launch of CapMac Studio, turns it on. Then open a new terminal (restart VS Code so its terminals get it too):

```powershell
npx cap run ios                  # builds on the Mac, launches, shows the app's console
ionic capacitor run ios -l       # Ionic live reload, through capmac's tunnel
```

Turn it off with `capmac takeover off`, or in CapMac Studio under **Settings › Terminal commands**. It stays off until you turn it back on.

| You type | CapMac does |
|---|---|
| `npx cap run ios [--target <id>]` | `capmac run`, without a web build (like `cap run`). In a terminal it stays attached to show the app's console; from a script it returns once the app is running. |
| `npx cap run ios --list [--json]` | Lists the Mac's simulators and devices, in Capacitor's format, so `ionic capacitor run ios` can ask which one to use. |
| `npx cap run ios -l [--host <h>] [--port <p>]` | `capmac dev` with your running dev server. With no `--host` or `--port`, CapMac starts the dev server itself. |
| `ionic capacitor run ios -l` | Ionic starts its dev server; CapMac tunnels it to the Mac. `--external` also works but isn't needed. |
| `npx cap open ios` · `ionic cap build ios` | Opens the project in Xcode on the Mac's screen. |
| `npx cap build ios` | `capmac build --ipa` into `ios/App/output`, with `--xcode-export-method` (`app-store-connect`, `release-testing`, `enterprise`, `debugging`), `--xcode-team-id`, `--scheme` and `--configuration`. |

Everything else (`cap sync`, `cap copy`, `cap add` and all of Android) still runs on Windows, unchanged. `capmac cap run ios -l` does the same without takeover.

**How it works:** takeover adds `--require %USERPROFILE%\.capmac\takeover.cjs` to your Windows user's `NODE_OPTIONS`. In every Node.js process, that small file checks whether the process is the Capacitor CLI running `run`, `open` or `build` for `ios`. If it is, CapMac runs the command instead; if not, it does nothing. Every way of starting Capacitor goes through it, whether `npx cap`, `ionic capacitor`, an npm script or a VS Code task, with no change to any project. CapMac Studio ships its own copy of the CLI for this, so takeover also works without `npm install -g capmac`; your terminal's Node.js runs it.

- `CAPMAC_TAKEOVER=0` runs one command with plain Capacitor (`$env:CAPMAC_TAKEOVER=0; npx cap run ios`).
- `capmac takeover off` turns it off at once, even in terminals that are already open. `capmac takeover on` turns it back on, and `capmac takeover` shows the current state.
- It is never turned on automatically in CI (`CI=true`) or by `npx capmac`, which runs a throwaway copy.
- Leave `%USERPROFILE%\.capmac\takeover.cjs` in place while takeover is on: Node.js stops with "Cannot find module" if `NODE_OPTIONS` points to a file that is missing. If CapMac itself is uninstalled, Capacitor runs as usual and prints a reminder.

## What you get

| | |
|---|---|
| **`capmac run`** | Builds your web app on Windows, syncs the project (only changed files), runs `npm install` + `npx cap sync ios` on the Mac when needed, builds with `xcodebuild`, installs and launches on a simulator or device, and streams the app's console (`console.log` from JS, native logs) until you press Ctrl+C. Web-only changes skip Xcode entirely and update the installed app in about a second. |
| **`capmac dev`** | Live reload. Your dev server (`vite`, `ng serve`, …) runs on Windows; an SSH reverse tunnel makes it `http://localhost:<port>` on the Mac, and the app is built to load from there. HMR works as usual. Native changes (Swift, plugins, `capacitor.config`, `package.json`) trigger an automatic rebuild. If the Mac sleeps or Wi-Fi drops, CapMac reconnects, restores the tunnel and relaunches by itself. Keys: `r` rebuild, `R` clean rebuild, `l` relaunch, `o` open screen, `q` quit. |
| **`capmac run --no-logs` · `--for <seconds>`** | For scripts and AI agents: return once the app is running, or show its console for that many seconds and then stop. |
| **`capmac screenshot [file]`** | Saves a full-resolution PNG of the running simulator and prints its path. |
| **`capmac skill`** | Teaches AI coding agents to use CapMac (see [AI coding agents](#ai-coding-agents)). |
| **`capmac logs`** | Streams the system log (os_log/NSLog) of the app running on a simulator. |
| **`capmac screen`** | The Mac's simulator in your browser (like Xamarin's *Remoted iOS Simulator*): click to tap, drag to swipe, scroll, type, Home/Lock buttons, screenshots, plus the app console side-by-side. Touch and typing go through CapMac's own helper, compiled on the Mac on first use; with an Xcode whose simulators don't take its input, [AXe](https://github.com/cameroncooke/AXe) is used when installed (`capmac doctor --fix` installs it). |
| **`capmac build --ipa`** | Archives and exports a signed `.ipa` (development, ad-hoc, app-store, enterprise) and downloads it to `build/ios/`. `--upload` sends it to App Store Connect/TestFlight instead. |
| **`capmac takeover [on\|off]`** | `npx cap run ios`, `ionic capacitor run ios`, `cap open ios` and `cap build ios` run on the Mac. On by default (see above). |
| **`capmac doctor [--fix]`** | Checks this PC, the connection and the Mac (Xcode, license, simulators, Node, CocoaPods, disk, signing) and fixes what it can. |
| **`capmac targets`** | Lists simulators and connected devices. Pick with `--target "iPhone 16 Pro"` or `--device`. |
| **`capmac exec -- <cmd>`** | Runs any command inside the project on the Mac (`capmac exec -- pod update`). |
| **`capmac pull <path>`** | Copies files back from the Mac (e.g. after `capmac exec -- npx cap add ios`, run `capmac pull ios`). |
| **`capmac open`** | Opens the synced project in Xcode on the Mac's screen. |
| **`capmac info`** | Shows what CapMac detected and which files it would sync — no Mac needed. |
| **`capmac sync`, `logs`, `clean`, `keychain`, `macs`, `use`, `unpair`** | The rest of the toolbox; `capmac <command> --help` for details. |

Build errors come back as `C:\path\to\your\file.swift:12:9: error: …` — clickable in VS Code's terminal and matched by the built-in `$gcc` problem matcher. App logs show JS `console.*` calls (`js`), Capacitor's own messages (`cap`) and native output (`ios`); add `--os-logs` to also see NSLog/os_log like Xcode's console, or `--bridge` for plugin call traffic.

**Live reload details:** CapMac points the app's bundled `capacitor.config.json` at the tunnelled dev server and adds an `NSAllowsLocalNetworking` exception to the Mac's copy of `Info.plist` (your own files are never touched), so plain-HTTP dev servers load on iOS 17+. Both are undone automatically on the next `capmac run`.

### VS Code

Add to `.vscode/tasks.json` to get build errors in the Problems panel:

```json
{
  "version": "2.0.0",
  "tasks": [
    { "label": "iOS: run on Mac", "type": "shell", "command": "npx capmac run", "problemMatcher": "$gcc" },
    { "label": "iOS: live reload", "type": "shell", "command": "npx capmac dev", "isBackground": true, "problemMatcher": "$gcc" }
  ]
}
```

## AI coding agents

Claude Code, Codex, GitHub Copilot, Cursor and other coding agents can drive CapMac too. Give them the **CapMac skill**, a short `SKILL.md` in the [Agent Skills](https://agentskills.io) format. It teaches an agent to build your iOS app on the Mac, run it, read its console, take a screenshot, fix build errors and leave password prompts to you.

```powershell
capmac skill add                                       # asks which agents (the ones on this PC are ticked) and where
capmac skill add --agent claude-code,codex --global    # for all your projects
capmac skill add --agent all --project                 # into this repository, to commit for your team
capmac skill                                           # which agents have it, globally and in this project
capmac skill remove --global
```

In CapMac Studio: **Settings › Terminal commands › AI coding agents › Set up…**, with the same choices.

| Agent | All your projects | One project |
|---|---|---|
| Claude Code | `~\.claude\skills\capmac` | `.claude\skills\capmac` |
| Codex, GitHub Copilot, Cursor, Gemini CLI, Cline, Kilo Code, Amp, Augment, Goose | `~\.agents\skills\capmac` (shared) | `.agents\skills\capmac` (shared) |
| OpenCode | `~\.config\opencode\skills\capmac` | `.agents\skills\capmac` |
| Windsurf (Devin Desktop) | `~\.codeium\windsurf\skills\capmac` | `.windsurf\skills\capmac` |
| JetBrains Junie | `~\.junie\skills\capmac` | `.agents\skills\capmac` |

Most agents read the shared `.agents\skills` folder, so CapMac writes it once for all of them. Project skills go at the repository root. CapMac only replaces or removes copies it wrote itself. For any other agent, `capmac skill show` prints the skill to paste where that agent reads instructions.

Agents run `capmac` as a command. If new terminals can't find it (no `npm install -g capmac`), `capmac skill add` offers to add it, and so does CapMac Studio, whose built-in CLI then serves as the command. Either way it goes in `%LOCALAPPDATA%\capmac\bin`, on your user PATH, and `capmac skill remove --command` takes it off again, leaving the rest of PATH exactly as it was. Output in a pipe is plain text without colour codes, which is easier for agents to read.

## Running on an iPhone

1. Plug the iPhone into the Mac once (or pair it over Wi-Fi in Xcode › Window › Devices), tap **Trust**, and turn on **Developer Mode**.
2. Sign in to **Xcode › Settings › Accounts** on the Mac once.
3. `capmac run --device --team <YOUR_TEAM_ID>` (or set `ios.team` in `capmac.json`).

Code signing over SSH needs the Mac's login keychain unlocked; CapMac detects this and asks for your Mac password when needed (`capmac keychain` does it up front). In `capmac dev --device`, the tunnel is exposed on the Mac's LAN address so the phone can reach your dev server.

Xcode's own Apple ID session is unreliable over SSH ("Your session has expired", "No Accounts"). For dependable device builds give CapMac an **App Store Connect API key** — xcodebuild then manages profiles and registers new devices by itself:

```powershell
capmac run --device --team ABCDE12345 --api-key C:\keys\AuthKey_ABC123XYZ9.p8 --api-issuer 69a6de7e-…
```

…or set it once in `capmac.json` (`"ios": { "apiKey": { "path": "../keys/AuthKey_ABC123XYZ9.p8", "issuerId": "69a6de7e-…" } }`) or via `CAPMAC_ASC_KEY_PATH` / `CAPMAC_ASC_KEY_ID` / `CAPMAC_ASC_ISSUER_ID`. The same key is used by `capmac build --ipa` and `--upload`.

## Configuration (optional)

`capmac.json` next to `capacitor.config.*`:

```json
{
  "host": "studio",
  "ios": { "target": "iPhone 16 Pro", "team": "ABCDE12345", "configuration": "Debug", "scheme": "App" },
  "web": { "build": "npm run build", "dev": "npm run dev", "devUrl": "http://localhost:5173" },
  "sync": { "exclude": ["docs/", "*.mp4"], "include": [".env.ios"] }
}
```

**What gets synced:** everything git would track, plus the iOS project in full (so gitignored files like `GoogleService-Info.plist` come along) and your built web assets. Never synced: `node_modules` (installed on the Mac for macOS), `android/`, `Pods/`, build output. Add a `.capmacignore` (gitignore syntax) for anything else. Run `capmac info --files` to see the exact list. Shell scripts are converted to LF line endings and marked executable on the way.

Monorepos work: CapMac syncs from the folder that holds the lockfile and runs Capacitor in your app's subfolder.

## How it works

- **One SSH connection** (via [ssh2](https://github.com/mscdex/ssh2)) carries everything: commands, file transfers, log streams, screen frames and the dev-server tunnel. No extra ports, no daemon, no firewall changes on the Mac.
- **The agent** is a single dependency-free Node.js script that CapMac uploads to `~/.capmac/agent/<hash>/` and runs per operation. Closing the connection (Ctrl+C) stops whatever it was running.
- **Incremental sync:** CapMac hashes your files (cached by size + mtime), the Mac replies with what it is missing, and only those files travel as one compressed stream.
- **Smart rebuilds:** CapMac classifies each change — dependencies → `npm install` + `cap sync`; native → `xcodebuild`; web only → `cap copy` and a one-second update of the installed simulator app.
- **Project copies** live in `~/.capmac/projects/<app>-<id>/` on the Mac (source mirror, DerivedData, build logs). `capmac clean --all` removes one.

## Security

- SSH key authentication with a dedicated ed25519 key; the Mac's host key is pinned at pairing time and checked on every connection.
- Your Mac password is used once at pairing (to install the key) and, if needed, to unlock the keychain for code signing. It's never stored.
- CapMac only writes inside `~/.capmac` on the Mac (and `~/.ssh/authorized_keys` once, at pairing).
- The remote-screen page listens on `127.0.0.1` only.

## Troubleshooting

| Problem | Fix |
|---|---|
| `The Mac refused the SSH connection` | Turn on Remote Login on the Mac. |
| `Node.js was not found on the Mac` | `capmac doctor --fix` installs a private copy. |
| Xcode license / first launch | `capmac doctor --fix` (asks for the Mac password for `sudo`). |
| `errSecInternalComponent` while signing | The keychain is locked over SSH: `capmac keychain`. |
| `Signing for "App" requires a development team` | `--team <TEAM_ID>` or `ios.team` in `capmac.json`. |
| Private npm registry fails on the Mac | Put the token in `~/.npmrc` on the Mac (env vars from Windows don't travel). |
| Simulator won't boot (`launchd_sim`, `CoreSimulatorService`) | Log in to the Mac's desktop as the paired user; simulators need a GUI session. |
| App built with Xcode 27 doesn't launch | iOS 27 requires the UIScene lifecycle: run `npx cap migrate` (Capacitor 8.5+). |
| Device build: "No Accounts" / "session has expired" | Use an App Store Connect API key (`--api-key`, see above). |
| Wrong files synced | `capmac info --files`, then adjust `.capmacignore` / `capmac.json`. |
| CapMac Studio shows the *compatible* stream | The note under the simulator says why. *Try the smooth stream* starts it again; *Restart simulator* fixes a simulator whose screen stopped updating. If the helper doesn't compile after an Xcode update, update CapMac. |

Add `--verbose` to any command to see full tool output. Build logs are kept on the Mac in `~/.capmac/projects/<id>/logs/`.

## Developing CapMac

```powershell
npm install
npm run build      # packages/cli/dist: cli.js (CLI), agent.mjs (Mac agent), viewer.html
npm test           # unit tests (engine, CLI, agent, desktop logic) + an SSH round-trip test
npm run typecheck
node bin/capmac.js --help

npm run desktop:dev    # CapMac Studio with hot reload (Vite for the UI; main, preload and engine rebuild and restart)
npm run desktop:test   # builds the app, then Playwright launches it with a fresh profile
npm run desktop:build  # installers and portable exes in apps/desktop/release/
```

The repo is an npm workspace:

| Folder | What |
|---|---|
| `packages/core` | `@capmac/core` (private): the engine both front ends share, the wire protocol (`src/shared`) and the Mac agent (`src/agent`). Consumed as TypeScript source; the engine reports through typed events and asks through a `Prompter`, it never prints. |
| `packages/cli` | `capmac`, the published CLI: commands, the terminal renderer for engine events, the browser screen viewer. Publish from this folder (`npm publish -w capmac`). |
| `apps/desktop` | CapMac Studio, the Windows desktop app (Electron 44, React 19, Vite 8). The engine runs in a utility process; the UI is a sandboxed renderer talking to it through a small validated API. See [docs/desktop-design.md](docs/desktop-design.md). |
| `spikes/streaming-v2` | The spike behind CapMac Studio's smooth simulator stream: the measurements and the tools used to explore Apple's private simulator interfaces. Results in the design doc. |
| `bin/capmac.js` | Runs the CLI from `packages/cli/dist` (so `node bin/capmac.js …` works from a clone). |

`examples/hello-capacitor` is a minimal Vite + Capacitor 8 (Swift Package Manager) app for trying things out.
