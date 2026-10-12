# capmac — Pair to Mac for Capacitor

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

`capmac pair` only needs your Mac password once: it installs a dedicated SSH key (`%USERPROFILE%\.capmac\id_ed25519`) and pins the Mac's host key. Node.js on the Mac is optional — if it's missing, capmac offers to install a private copy in `~/.capmac/runtime` (no sudo, nothing system-wide).

**Measured** on an M1 Mac (macOS 26.6, Xcode 26.6) over Wi-Fi with Capacitor 8.5 apps (Swift Package Manager and CocoaPods):

| | |
|---|---|
| First `capmac run` (npm install, `cap sync`, Swift packages, simulator boot) | ~50 s |
| `capmac run` again, nothing changed | ~6 s |
| Web-only change (no Xcode build) | ~5 s |
| Native (Swift) change, incremental build | ~10 s |
| `capmac dev`: save a file → app reloads | ~1 s |

## What you get

| | |
|---|---|
| **`capmac run`** | Builds your web app on Windows, syncs the project (only changed files), runs `npm install` + `npx cap sync ios` on the Mac when needed, builds with `xcodebuild`, installs and launches on a simulator or device, and streams the app's console (`console.log` from JS, native logs) until you press Ctrl+C. Web-only changes skip Xcode entirely and update the installed app in about a second. |
| **`capmac dev`** | Live reload. Your dev server (`vite`, `ng serve`, …) runs on Windows; an SSH reverse tunnel makes it `http://localhost:<port>` on the Mac, and the app is built to load from there. HMR works as usual. Native changes (Swift, plugins, `capacitor.config`, `package.json`) trigger an automatic rebuild. If the Mac sleeps or Wi-Fi drops, capmac reconnects, restores the tunnel and relaunches by itself. Keys: `r` rebuild, `R` clean rebuild, `l` relaunch, `o` open screen, `q` quit. |
| **`capmac logs`** | Streams the system log (os_log/NSLog) of the app running on a simulator. |
| **`capmac screen`** | The Mac's simulator in your browser (like Xamarin's *Remoted iOS Simulator*): click to tap, drag to swipe, scroll, type, Home/Lock buttons, screenshots, plus the app console side-by-side. Touch input uses [AXe](https://github.com/cameroncooke/AXe) on the Mac (`capmac doctor --fix` installs it); without it the screen is view-only. |
| **`capmac build --ipa`** | Archives and exports a signed `.ipa` (development, ad-hoc, app-store, enterprise) and downloads it to `build/ios/`. `--upload` sends it to App Store Connect/TestFlight instead. |
| **`capmac doctor [--fix]`** | Checks this PC, the connection and the Mac (Xcode, license, simulators, Node, CocoaPods, disk, signing) and fixes what it can. |
| **`capmac targets`** | Lists simulators and connected devices. Pick with `--target "iPhone 16 Pro"` or `--device`. |
| **`capmac exec -- <cmd>`** | Runs any command inside the project on the Mac (`capmac exec -- pod update`). |
| **`capmac pull <path>`** | Copies files back from the Mac (e.g. after `capmac exec -- npx cap add ios`, run `capmac pull ios`). |
| **`capmac open`** | Opens the synced project in Xcode on the Mac's screen. |
| **`capmac info`** | Shows what capmac detected and which files it would sync — no Mac needed. |
| **`capmac sync`, `logs`, `clean`, `keychain`, `macs`, `use`, `unpair`** | The rest of the toolbox; `capmac <command> --help` for details. |

Build errors come back as `C:\path\to\your\file.swift:12:9: error: …` — clickable in VS Code's terminal and matched by the built-in `$gcc` problem matcher. App logs show JS `console.*` calls (`js`), Capacitor's own messages (`cap`) and native output (`ios`); add `--os-logs` to also see NSLog/os_log like Xcode's console, or `--bridge` for plugin call traffic.

**Live reload details:** capmac points the app's bundled `capacitor.config.json` at the tunnelled dev server and adds an `NSAllowsLocalNetworking` exception to the Mac's copy of `Info.plist` (your own files are never touched), so plain-HTTP dev servers load on iOS 17+. Both are undone automatically on the next `capmac run`.

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

## Running on an iPhone

1. Plug the iPhone into the Mac once (or pair it over Wi-Fi in Xcode › Window › Devices), tap **Trust**, and turn on **Developer Mode**.
2. Sign in to **Xcode › Settings › Accounts** on the Mac once.
3. `capmac run --device --team <YOUR_TEAM_ID>` (or set `ios.team` in `capmac.json`).

Code signing over SSH needs the Mac's login keychain unlocked; capmac detects this and asks for your Mac password when needed (`capmac keychain` does it up front). In `capmac dev --device`, the tunnel is exposed on the Mac's LAN address so the phone can reach your dev server.

Xcode's own Apple ID session is unreliable over SSH ("Your session has expired", "No Accounts"). For dependable device builds give capmac an **App Store Connect API key** — xcodebuild then manages profiles and registers new devices by itself:

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

Monorepos work: capmac syncs from the folder that holds the lockfile and runs Capacitor in your app's subfolder.

## How it works

- **One SSH connection** (via [ssh2](https://github.com/mscdex/ssh2)) carries everything: commands, file transfers, log streams, screen frames and the dev-server tunnel. No extra ports, no daemon, no firewall changes on the Mac.
- **The agent** is a single dependency-free Node.js script that capmac uploads to `~/.capmac/agent/<hash>/` and runs per operation. Closing the connection (Ctrl+C) stops whatever it was running.
- **Incremental sync:** capmac hashes your files (cached by size + mtime), the Mac replies with what it is missing, and only those files travel as one compressed stream.
- **Smart rebuilds:** capmac classifies each change — dependencies → `npm install` + `cap sync`; native → `xcodebuild`; web only → `cap copy` and a one-second update of the installed simulator app.
- **Project copies** live in `~/.capmac/projects/<app>-<id>/` on the Mac (source mirror, DerivedData, build logs). `capmac clean --all` removes one.

## Security

- SSH key authentication with a dedicated ed25519 key; the Mac's host key is pinned at pairing time and checked on every connection.
- Your Mac password is used once at pairing (to install the key) and, if needed, to unlock the keychain for code signing. It's never stored.
- capmac only writes inside `~/.capmac` on the Mac (and `~/.ssh/authorized_keys` once, at pairing).
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

Add `--verbose` to any command to see full tool output. Build logs are kept on the Mac in `~/.capmac/projects/<id>/logs/`.

## Developing capmac

```powershell
npm install
npm run build      # packages/cli/dist: cli.js (CLI), agent.mjs (Mac agent), viewer.html
npm test           # unit tests + an SSH round-trip test against an in-process server
npm run typecheck
node bin/capmac.js --help
```

The repo is an npm workspace:

| Folder | What |
|---|---|
| `packages/core` | `@capmac/core` (private): the engine both front ends share, the wire protocol (`src/shared`) and the Mac agent (`src/agent`). Consumed as TypeScript source; the engine reports through typed events and asks through a `Prompter`, it never prints. |
| `packages/cli` | `capmac`, the published CLI: commands, the terminal renderer for engine events, the browser screen viewer. Publish from this folder (`npm publish -w capmac`). |
| `apps/desktop` | capmac Studio, the Windows desktop app (Electron). See [docs/desktop-design.md](docs/desktop-design.md). |
| `bin/capmac.js` | Runs the CLI from `packages/cli/dist` (so `node bin/capmac.js …` works from a clone). |

`examples/hello-capacitor` is a minimal Vite + Capacitor 8 (Swift Package Manager) app for trying things out.
