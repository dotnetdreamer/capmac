# capmac Studio — build an award-winning desktop app for capmac (Electron, Windows)

## Context

You're picking up **capmac** in `C:\Users\ik\Documents\GitHub\capacitor-xtool`: a "Pair to Mac" tool for Capacitor apps, like Xamarin's Pair to Mac. From Windows it builds, runs, live-reloads and shows a Capacitor iOS app on a Mac over SSH. The CLI is finished and was verified end to end on my real Mac in the previous session. You have no memory of that session; everything you need is below and in the repo.

**Your job this session:** design and build **capmac Studio**, a Windows desktop app (Electron) that puts capmac behind an award-winning UI. Build it so it can grow into a full remote iOS Simulator for Windows (high-fps video, touch, keyboard, gestures).

## Ground rules

- Work autonomously. Ask me only when you truly need me: my Mac password, installing software on the Mac, plugging in or unlocking my iPhone, or a product decision this brief doesn't answer.
- Test against my real Mac (already paired). Don't build fake Mac or mocked Xcode environments.
- Never kill processes you didn't start. I run many unrelated Vite/Node dev servers on this PC (another project already owns `127.0.0.1:5173`).
- Don't install anything on the Mac (for example AXe via Homebrew) or globally on this PC (`npm -g`, `npm link`) without asking.
- Fetch current docs with the ctx7 CLI (Electron, electron-builder, Vite, React, Playwright, …); it's late 2026 and these move fast.
- Keep the CLI working: `npm test` (69 tests), `npm run typecheck` and `npm run build` stay green, and `node bin/capmac.js run|dev` still work on the Mac.
- Git: the repo has no commits yet. Make one baseline commit of the current state before you refactor, then commit at the end of each milestone. Don't push.

## What exists — read first

- `README.md`: features, commands, configuration, measured timings, troubleshooting.
- **How it works:** Windows CLI (Node 20+, TypeScript, ESM, esbuild) ⇄ **one SSH connection** (`ssh2`) ⇄ a dependency-free Node **agent** that the CLI uploads to the Mac (`~/.capmac/agent/<hash>/agent.mjs`). Each operation runs as one agent process on its own SSH exec channel. Messages are length-prefixed JSON/binary frames, and closing the channel cancels the operation.
- **Layout:**
  - `src/shared/`
    - `frames.ts`: the wire protocol.
    - `protocol.ts`: every op's params and results, plus the event types.
    - `archive.ts`: sync archive format.
    - `xcode-output.ts`: xcodebuild output parser.
    - `app-log.ts`: Capacitor log classifier.
    - `classify.ts`: what a changed file means (deps / native / web).
    - `paths.ts`: maps Mac paths back to Windows paths.
  - `src/agent/` runs on the Mac.
    - `main.ts` dispatches the ops: probe, sync, prepare, build, archive, download, deploy, boot, logs, targets, screen, exec, pull, keychain, keychain-status, clean, open-xcode, relay, install-tools.
    - Helpers: `proc.ts` (process groups, cancellation), `env.ts` (PATH/LANG for SSH sessions), `state.ts` (per-project state and lock), `ios-project.ts`.
  - `src/cli/` is the Windows side.
    - `session.ts`: connect, then start the agent.
    - `ssh.ts`: `MacConnection` (exec, scripts, reverse tunnels).
    - `agent-client.ts`: calls agent ops.
    - `scan.ts` + `sync-client.ts`: incremental sync.
    - `pipeline.ts`: web build → sync → prepare → target → build → deploy.
    - `commands/*`: pair, doctor, run, dev, build, tools.
    - `devserver.ts`, `watch.ts`.
    - `render.ts` (agent events → terminal) and `ui.ts` (spinners, prompts).
    - `resolve.ts`: `.local` name fallback.
    - `discovery.ts`: Bonjour discovery of Macs.
    - `viewer/`: browser-based remote screen (`server.ts` + `page.html`).
  - `test/unit/`: vitest, including an SSH round-trip test against an in-process ssh2 server.
  - `examples/hello-capacitor/`: Vite 8 + Capacitor 8.5 (SPM) + `@capacitor/device`, used for real-Mac testing.
- **Verified on the Mac:**
  - `run` (SPM and CocoaPods projects).
  - The web-only fast path: the installed simulator app is patched, with no Xcode build.
  - Live reload with Vite HMR through a reverse tunnel.
  - Automatic native rebuilds.
  - Auto-reconnect when the SSH connection drops.
  - Compile errors mapped to clickable Windows paths.
  - Remote screen (MJPEG), `logs`, `exec`, `pull`, `clean`.
- **Not yet verified:**
  - Physical device runs and `.ipa` export. Both need the keychain unlocked with my password.
  - Touch input. It needs AXe on the Mac.

## The Mac (already paired)

- **Connection:** alias `ik-s-m1` → `ik@IKs-M1.local`. The config is in `%USERPROFILE%\.capmac\config.json` and the key in `%USERPROFILE%\.capmac\id_ed25519`.
- **Setup:**
  - Apple silicon, macOS 26.6.1, Xcode 26.6.
  - iOS 26.5 simulators; "iPhone 17" is the default target.
  - Node 24 at `/usr/local/bin/node`, CocoaPods 1.16.2.
- **Limits:**
  - AXe is not installed. Touch input needs it; ask me first.
  - The login keychain is locked over SSH. Device builds and IPA export need my password via `capmac keychain`.
  - The iPhone "IK 14 Pro Max" is paired but usually not plugged in.
- **Health check:** `cd examples/hello-capacitor && node ../../bin/capmac.js doctor`.

## Hard-won facts (don't relearn these)

- **ssh2 imports:** `ssh2` is CommonJS. `Client` imports by name; `utils` and `Server` need the default import.
- **Launch detection:** `simctl launch --console-pty` prints `<bundle>: <pid>` through buffered stdio, so it only appears when simctl exits. Treat the app's first output line, or about 4 quiet seconds, as "launched".
- **Device console:** `devicectl … --console` only streams app output with a TTY, so it's wrapped in `script -q -t 0 /dev/null`.
- **`.local` names:** Windows' resolver is flaky for them. `resolve.ts` falls back to a multicast DNS query, then to the last known IP.
- **Bundled web folder:** Capacitor refuses to start without a bundled `public/` folder, even when `server.url` is set. A stub is written in live mode.
- **Live-reload Info.plist patch:** live mode adds `NSAllowsLocalNetworking` to the Mac's copy of `Info.plist` only, and updates the sync manifest so the file isn't re-uploaded. Never touch the user's own files.
- **Signing over SSH:**
  - It fails with `errSecInternalComponent` while the keychain is locked.
  - Xcode's account login is unreliable over SSH; App Store Connect API keys are supported (`--api-key`).
- **Desktop session:** simulators need the user logged in to the Mac desktop.
- **Xcode 27:**
  - Simulator.app became Device Hub (`open -b com.apple.dt.Devices`).
  - `devicectl` JSON is now version 5: `properties.*` replaces the old fields, and simulators are listed too.
  - Legacy Indigo HID input was removed; input tools must use the newer DTUHID path.
  - The iOS 27 SDK requires the UIScene lifecycle (`npx cap migrate`).
- **Current screen capture:** `simctl io screenshot --type=jpeg` takes about 0.13 s and a `sips` downscale about 0.06 s. Frames are about 55 KB at about 5 fps, and unchanged frames are skipped.
- **AXe:** its `stream-video` has an open memory leak (issue #72) that can force a macOS logout, so don't use it for streaming. It's fine for input; coordinates are in points.
- **Vite on Windows:** Vite binds `localhost` to `::1`, so the tunnel connects to `localhost` with `autoSelectFamily`.
- **Runtime files:** `agentBundle()` in `agent-client.ts` reads `dist/agent.mjs` from disk at runtime, and the viewer reads `dist/viewer.html`. A packaged Electron app must ship them unpacked (`extraResources`) and resolve them from there.
- **ssh2 native addons:** ssh2's optional native addons (`cpu-features`, `sshcrypto`) aren't needed. Exclude them from Electron builds to avoid rebuild trouble.
- **First discovery:** Bonjour discovery binds UDP 5353, so Windows may show a firewall prompt the first time. Explain this in the UI before the first scan.

## What to build

### Product

A native-feeling Windows 11 app: Linear/Raycast-level polish applied to iOS development from Windows. Working name "capmac Studio"; propose a better one if you like.

1. **First run / pairing**
   - Discover Macs on the network (already implemented in `discovery.ts`) and pair with the password once.
   - Show the health checklist (`doctor`) live, with one-click fixes.
   - End with "Run the sample app" as the success moment.
   - It should take under 2 minutes from install to an app on the simulator.
2. **Projects**
   - Add a Capacitor app with a folder picker or drag and drop.
   - Show its icon (from `ios/App/App/Assets.xcassets/AppIcon.appiconset`), name, app id, iOS package manager (SPM/CocoaPods) and sync size.
   - Keep a list of recent projects.
3. **Workspace** (per project)
   - **Toolbar:** Mac picker, target picker (simulators and devices with live state), **Run**, **Live** (dev mode), **Stop**, Build IPA, Open in Xcode.
   - **Panes:** Simulator, Console, Problems, Build timeline. Resizable, and their layout is remembered.
   - **Build timeline:** Sync → Dependencies → cap sync → Xcode build → Boot → Install → Launch. Live progress text and durations; skipped steps are shown as skipped ("native code unchanged").
   - **Problems:**
     - Diagnostics with code excerpts.
     - Click to open in VS Code (`code -g file:line:col`) or the default editor.
     - Copy, and "show full build log".
   - **Console:**
     - Virtualized for 100k+ lines.
     - Source filters (JS / Capacitor / Native / Bridge) and level filters.
     - Search with highlighting, and pause/auto-scroll.
     - Pretty-printed, expandable JSON for `console.log` objects.
     - Timestamps, copy and export.
   - **Live mode card:** dev server URL, HMR state, tunnel state, and an auto-reconnect banner ("Mac asleep — reconnecting…").
4. **Simulator pane v1**
   - Reuse the existing agent `screen` op and AXe input: tap, swipe/drag, scroll, type, Home/Lock, screenshot (save/copy), device frame.
   - Without AXe, show "view-only, install AXe". You may offer the install, but ask me first.
   - Draw frames on a canvas, decoding JPEGs in a worker with `createImageBitmap`, instead of an MJPEG `<img>`.
   - `src/cli/viewer/page.html` is a working reference for mapping pointer events to tap/swipe.
5. **Devices & Macs**
   - Lists with live state.
   - Boot/shutdown simulators.
   - Device connection and developer-mode status.
   - `doctor` results per Mac.
6. **Everywhere**
   - Command palette (Ctrl+K) with every action, plus keyboard shortcuts.
   - Tray icon: run last project, stop, open.
   - A Windows notification when a build finishes while the window is in the background.
   - Designed empty and error states. Every error says what happened and how to fix it, never a raw stack trace.
   - Light/dark/system themes, Windows 11 Mica backdrop, a custom title bar.
   - Crisp at 100–250 % display scaling.
   - Full keyboard and screen-reader accessibility; `prefers-reduced-motion` respected.

### Architecture

- **Engine extraction.** Pull an engine out of the CLI so both front ends share it.
  - Today `pipeline.ts`, `sync-client.ts`, `devserver.ts`, `render.ts` and the commands write straight to the terminal through `ui.ts`.
  - The engine should emit typed events: step start/progress/end, diagnostic, app log line, info/warning, state changes.
  - It should request input through callbacks: the password for pairing, keychain or sudo, and confirmations.
  - The CLI becomes a thin renderer of those events; the desktop app forwards them over IPC.
  - Recommended: npm workspaces with `packages/core` (engine + shared + agent), `packages/cli` and `apps/desktop`, keeping the published `capmac` package and `bin/capmac.js` working. Decide and document it.
- **Electron (latest stable).**
  - The main process owns the engine, or a `utilityProcess` does.
  - The renderer is React + TypeScript + Vite; justify any other choice.
  - `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict CSP.
  - A minimal typed preload API via `contextBridge`, with every IPC payload validated.
  - `setWindowOpenHandler` denies everything, and the app takes a single-instance lock.
  - Binary streams such as screen frames go over a `MessagePort` with transferables, not JSON.
- **Secrets.** Never store passwords. If something must be remembered, use Electron `safeStorage`.
- **Packaging.**
  - electron-builder: NSIS installer plus a portable build, Windows x64 and arm64.
  - An app icon, and the version taken from `package.json`.
  - Scripts `desktop:dev` and `desktop:build`.
- **Tests.**
  - Engine unit tests (vitest).
  - A Playwright `_electron` smoke test: launch, show home, open a project.
  - Keep every existing test.

### Simulator streaming v2 (plan it now, build after v1)

Target: 30–60 fps and under 100 ms latency over Wi-Fi, through the existing SSH connection (no new ports).

- **Video:**
  - Capture the simulator framebuffer (IOSurface) on the Mac and encode H.264/HEVC with VideoToolbox.
  - Decode in Electron with WebCodecs `VideoDecoder` (hardware accelerated) onto an (Offscreen)Canvas.
  - Keyframes on demand; drop frames under backpressure; keep MJPEG as the fallback.
- **Input:**
  - Multi-touch: pinch/rotate, like the Simulator's Option-drag.
  - Hardware keyboard passthrough with modifiers, hardware buttons, rotation.
  - Clipboard sync both ways.
- **Extras via simctl:**
  - Drag and drop photos/videos (`addmedia`) and open deep links (`openurl`).
  - Send push notifications (`push`) and set the location (`location`).
  - Switch appearance (`ui appearance`), override the status bar, set privacy permissions.
  - Screen recording.
- **Prior art to evaluate.** Ask before installing anything on the Mac; these notes come from last session's research:
  - **baguette** (tddworks): `baguette serve` gives a WebSocket with MJPEG/AVCC video, plus gesture JSON in points. Its notes say iOS 26 needs the 9-argument Indigo mouse message, and that Xcode 27's Device Hub shadows input.
  - **serve-sim** (EvanBacon, Apache-2.0): IOSurface → H.264 over WebSocket, decoded with WebCodecs.
  - **idb**: `idb video-stream --format h264`; on Xcode 27 its input uses DTUHID.
  - Radon IDE's simulator-server is closed source; don't use it.
  - Also consider a small Swift helper compiled on the Mac with the `swiftc` that ships with Xcode, run as a new agent op.
- **Deliverable:** a spike with measured fps, latency and bandwidth, and a recommendation.

## Deliverables for this session

1. `docs/desktop-design.md`:
   - information architecture and screens;
   - visual language (tokens, type scale, spacing, motion) and a component inventory;
   - the engine API and the streaming v2 plan.
2. Engine extraction with CLI parity: all tests green, and `capmac run` / `dev` re-verified on the Mac.
3. The desktop app running with `npm run desktop:dev`:
   - onboarding/pairing and projects;
   - the workspace: target picker, Run/Live/Stop, build timeline, problems, console;
   - simulator pane v1, devices/Macs, settings;
   - command palette, tray, notifications.
4. Screenshots of every main screen in light and dark. Capture them yourself, review them critically, and iterate until they're excellent. Show them to me at the end.
5. A packaged Windows installer, built locally.
6. The streaming v2 spike results and recommendation, if time allows.

## Quality bar

Award-level means:
- It feels native and calm.
- Every state is designed: loading, empty, error, offline, reconnecting.
- Nothing janks: 60 fps UI, cold start under 2 s, idle CPU near zero.
- Zero errors in DevTools.
- Consistent spacing and type.
- Fully usable by keyboard and screen reader.
- The core loop feels instant and delightful: open project → Live → see the app → edit → it updates.

Review your own screenshots like a design critic before calling anything done.

## How to work

1. Read `README.md`, `src/shared/protocol.ts`, `src/cli/pipeline.ts`, `src/cli/commands/dev.ts`, `src/agent/main.ts` and `src/cli/viewer/*`.
2. Run `npm install && npm test && npm run build`. Then run `node ../../bin/capmac.js doctor` in `examples/hello-capacitor` to confirm the Mac is reachable.
3. Make the baseline commit and write the design doc. Then build milestone by milestone, verifying each against the Mac and committing at each milestone.
4. Finish with a short summary:
   - what works, verified on the Mac;
   - screenshots;
   - what needs me;
   - what's next.
