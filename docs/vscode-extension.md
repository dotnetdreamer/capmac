# CapMac for VS Code: design notes

The extension (`apps/vscode`, package `capmac-vscode`) is CapMac's third front end, beside the `capmac` CLI and CapMac Studio. Like them, it is a thin layer over the shared engine, `@capmac/core`.

## The engine: Studio's host, unchanged

The extension runs **CapMac Studio's engine host** (`apps/desktop/src/engine/host.ts`) as it is, in a Node.js child process of its own:

```
VS Code extension host                         engine process (Code.exe as Node.js)
 ├─ EngineClient (src/engine/client.ts)  ──IPC──►  parent-port.ts  ──►  Studio's host.ts  ──►  @capmac/core
 │   calls · prompts · screens                      process.parentPort stand-in,           (SSH to the Mac, WSL,
 │                                                  screen ports by stream id              Flutter, Electron, …)
 └─ views, debug adapter, webview …
```

- The host talks to Electron's `process.parentPort` and gets each screen's `MessagePortMain` in `e.ports`. `src/engine/parent-port.ts` provides both over Node's IPC channel, a screen's messages tagged with its stream id (`src/engine/wire.ts`). Nothing in `host.ts` changes, so every engine method Studio has, the extension has: when a branch adds a method or a session kind to the host and `contract.ts`, the extension can call it.
- `child_process.fork` runs `dist/engine.cjs` with VS Code's own binary (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`) and `serialization: 'advanced'`, so frames arrive as `ArrayBuffer`s, not JSON. Both ends must be the same V8 build (they are: the extension host is that binary too).
- `EngineClient` is Studio's `main/engine.ts` for a child process: typed `call`/`invoke` over `contract.ts`, batched events, prompts and their withdrawal, a channel per screen (`openScreen`, commands queued behind the open), restarts after a crash (5 a minute), and a clean shutdown in `deactivate()` (the shim also shuts down when the extension host goes away).

Two build-time values come from `contract.ts`'s text (`scripts/build.mjs`): the `sessions.start` modes (Sync is offered because the engine has it) and the `projects.createSample` kinds (the samples *Try a Sample App* offers). The extension bundle therefore has no zod (it is 180 KB minified).

## The workspace is the project

`src/state/model.ts` holds what the extension knows: the engine's state, the paired Macs, each Mac's simulators and devices (`targets.watch` while VS Code has focus), the apps found in every workspace folder (`projects.detect`), project summaries, the runs, this PC's setup, health checks and a log ring per project (for the agents' `capmac_logs`).

The app being worked on (`current()`): the one picked in VS Code (workspace state) unless the CLI or Studio picked another since, else the one around the open file, else the engine's suggestion. Picking an app calls `projects.setApp`, so the CLI and Studio follow. Where it builds (`projects.setBackend`) is shared the same way; the Mac and the simulator picked are per workspace, as Studio keeps them per project.

`sessionParams()` turns the current app and destination into `sessions.start` parameters exactly as Studio's toolbar does (`target: 'mac-desktop'` for Mac apps, `'pc-desktop'` for Windows apps, `backend: 'wsl'` for an iPhone on this PC); the host routes the rest (`startSession`, `startFlutterSession`, `startPcSession`).

The web build runs on this PC, and its errors arrive only as output (`tool-output`): while a run's `web` step runs, the model reads that output with core's `JsDiagnosticParser` (TypeScript, esbuild, Vite 7 and Rolldown/Vite 8; `WebBuildDiagnostics` in `src/state/pure.ts` keeps Windows paths whole) and puts a `diagnostic` event after the line that completed each error, so the Run view, Problems and the Debug Console get them like Xcode's.

`src/state/runs.ts` is Studio's run reducer (`renderer/state/runs.ts`), ported: Studio's own is not exported and its module pulls in renderer state. Differences: `step-progress.done` is kept as a file count (Studio draws it as a fraction), Sync and "no web build" runs are understood, React Native and Expo get native steps, and a step a run reports outside its list still shows.

## Runs are debug sessions

`src/debug/adapter.ts` is an inline debug adapter (no process): F5/Ctrl+F5, Stop, Restart and the debug toolbar drive the engine session; the Debug Console shows steps, the app's console (with `source`/`line` links for page logs), dev server output, diagnostics and errors, with ANSI colours. Typed `r R b s o q help` work like the CLI's keys. DAP progress events carry the current step. `src/debug/provider.ts` lists every app as a dynamic configuration ("Live: Hello CapMac · iPhone 17 Pro"), under the workspace folder it was found in (VS Code asks once per folder, then again for the workspace and the user's settings, which get none: else each entry showed once per folder and twice more), and checks what a run needs before it starts (a paired Mac, this PC set up), saying what to do without waiting for an answer.

Live actions (`src/session.ts`): `r` is `sessions.reload` for Flutter, React Native, Expo and Electron and `sessions.rebuild` for Capacitor (its web view reloads on save by itself); `R` is `sessions.relaunch` (Flutter: hot restart).

## The screen

`src/screen/panel.ts` opens one webview tab that follows the current app (and comes back after a reload). The page (`src/webview/screen`) is plain TypeScript:

- the decoder is **Studio's `renderer/workers/screen.worker.ts`, unchanged**, started from a blob (webviews can't start workers from their resource URLs); a `MessageChannel` stands in for Studio's screen port, messages that arrive before the worker are queued, and every message carries its stream id;
- input is Studio's (`Simulator.tsx`, `AppWindow.tsx`) ported: touch streaming with Alt to pinch, AXe gestures, wheel scrolling in points, HID keystrokes, paste; Mac-style mouse and keys for app windows;
- an Electron app's dialogs (`AppDialog.tsx`, ported) and its sound (`lib/app-audio.ts`, unchanged);
- Studio's strings (`shared/i18n/en.ts`) are bundled in, so both say the same thing; colours come from the VS Code theme.

**Copy screenshot**, as in Studio: VS Code's clipboard API takes text only, so the page writes the PNG itself with `navigator.clipboard.write` (webviews may write the clipboard). The write starts in the click, with a `ClipboardItem` whose PNG is a promise the extension's screenshot fills, so it still counts as the click's. Checked live (2026-10-18): a simulator's full-size 1206×2622 PNG on the Windows clipboard

An iPhone at this PC (no Mac) has a screen too (`backend: 'wsl'` screens, `src/state/screens.ts`): the one mirroring to CapMac's receiver over Wi-Fi, or, while nothing mirrors and touch is on over the cable, WebDriverAgent's picture over the cable. With no iPhone found the tab still shows one that mirrors (`wifi-mirror`). The iPhone sends a keyframe only when mirroring starts, so the tab keeps its one stream: another iPhone or app moves touch with `phone-target` instead of a new stream, and the worker never skips frames to wait for a keyframe. **Turn on touch** calls `iphone.setUpTouch`; screenshots come from the open stream (`iphone.screenshot`). Gestures go out as Studio's (`gesture.ts`): a long press before a drag and a hold before lifting come through as `pressMs`/`holdMs`. The Windows `.vsix` ships the receiver (`dist/mirror-receiver`, staged like Studio's installer; production builds need it), and `src/mirrorReceiver.ts` copies it once to `%LOCALAPPDATA%\CapMac\mirror-receiver\<version>`, where the engine looks: Windows Firewall asks about each new path of `uxplay.exe`, and the extension's folder changes with every update. CI's `.vsix` gets the receiver its installers ship (`CAPMAC_MIRROR_RECEIVER`), and checks it is in there. Verified live (2026-10-18, IK 14 Pro Max, iOS 26.6.2): the picture over the cable with touch, a swipe to the App Library and back, Control Center and Screen Mirroring driven from the tab, the AirPlay picture at 59 fps, a full-size screenshot.

Mirroring ends when UxPlay says its stream stopped (`video_reset: type = RTP_Shutdown` after the iPhone's TEARDOWN, or its lost-connection reset), not when its count of open connections reaches 0 (`receiver.ts`). A connection left open by an earlier attempt kept that count above 0, and the tab stayed on a frozen picture after Stop Mirroring. Checked live (2026-10-18, a TCP connection held open to every port `uxplay.exe` listens on): the engine before the fix never left the frozen picture; with it, the cable's picture came 1.8 s after Stop Mirroring

## The rest

| File | What |
| --- | --- |
| `src/ui/runTree.ts` | Run view: the app, where it runs, the run's steps, problems, dev server, IPA, build log |
| `src/ui/appsTree.ts` | Apps view: every app found, grouped by project; ones CapMac can't run yet are shown as such |
| `src/ui/devicesTree.ts` | Devices view: Macs (simulators grouped by iOS version, devices, Mac desktop, health with fixes) and this PC |
| `src/ui/statusBar.ts`, `codeLens.ts`, `diagnostics.ts` | Status bar, Run/Live above config files, Problems |
| `src/ui/prompts.ts` | The engine's questions as input boxes, pick lists and dialogs; a "waiting" question (a browser sign-in) is a progress notification the engine can withdraw |
| `src/ui/pickers.ts` | Choosing the app, where it runs, where it builds; pairing with Bonjour/Tailscale discovery; Build an IPA's kinds, upload, team and folder (the team and folder kept per project in workspace state) |
| `src/ui/remote.ts` | Remote access, as Studio's Mac card (`features/macs/RemoteAccess.tsx`): on (asking for the server first when there is none), route, relay, keep awake, test, the PCs (revoke), move to the saved server, off (on this PC only when the Mac can't be reached), and the server setting |
| `src/pcSetup.ts` | This PC's setup (WSL backend) in a progress notification, and its health check |
| `src/lm/tools.ts` | `capmac_status`, `capmac_run`, `capmac_stop`, `capmac_screenshot` (an image from VS Code 1.110), `capmac_logs` |
| `src/terminal.ts` | `capmac` in VS Code's terminals (core's `launcherFiles`, appended to PATH), and on the extension host's own PATH for the agents other extensions start |
| `src/skill.ts` | CapMac's skill for coding agents (core's `agent-skills.ts`): added by itself as `capmac.agents.addSkill` says, **Add the CapMac Skill for AI Agents…** and **Remove the CapMac Skill for AI Agents…** (core's `removeSkill`, which never removes a skill CapMac didn't write; the place is then remembered, so CapMac doesn't add it back by itself) |
| `src/i18n.ts` | The extension's own words; Studio's are reused |

## The skill for coding agents

Core's installer (the same one as `capmac skill` and Studio's dialog) does the writing; the extension decides when and for whom.

- **Which agents:** core's list, found four ways (`detectAgents`): the editor itself (`vscode.env.appName`/`uriScheme`: Cursor, Windsurf, Antigravity), the agents' extensions in it (`anthropic.claude-code`, `openai.chatgpt`, `github.copilot-chat`, `google.geminicodeassist`…, `editorAgents` in `state/pure.ts`), the project's own files (core's `marks`: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor`…) and the agent's settings folder on this PC (core's `detect`). VS Code 1.142's built-in Copilot Chat runs in its own agent host and is not in `vscode.extensions.all` (checked with a probe extension); Copilot is found by its settings folder (`%APPDATA%\Code\User`) instead. So `.agents/skills` (read by most agents) almost always gets a copy, and `.claude/skills` when Claude Code is found.
- **When:** with `capmac.agents.addSkill` = `project` (the default), the first time detection finds a runnable app in a project root (the repository root, as core's `skillProjectRoot`; Claude Code and Codex look up to it from a subfolder). Agents that already see a CapMac copy (in the project, or for all projects) are skipped. Each root is remembered in `globalState` (`capmac.skill.projects`) with the CapMac version, so a removed copy stays removed; with each new version CapMac offers once to update its own older copies (`skillSteps`). `global` adds it once to the user's folders (`capmac.skill.profile`); `off` does nothing by itself.
- **Never over someone's skill:** core's `skillPlan` tells, before writing, what is in each folder (missing, current, changed, older, newer, foreign). The automatic add writes only missing copies and asks (a notification) before replacing a foreign one; the command lists everything that is there in a modal and writes only the missing copies unless the user picks Replace.
- **The `capmac` command for those agents:** the Claude Code and Codex panels start their agent from the extension host with its `process.env`, not a terminal's, so `terminal.ts` also appends the launchers' folder to `process.env.PATH` (checked in the `skill` integration run by running `capmac --version` from the test, which lives in the same host). Agents started before CapMac activates keep the PATH they had.

## Testing

- `npm test` (root) includes `apps/vscode/test/unit`: the run reducer, the pure helpers, and the bridge, against a fake host and against **Studio's real host** (bundled on the fly, with an empty `CAPMAC_CONFIG_DIR`).
- `npm run vscode:test` builds and runs `test/integration` in a real VS Code (`@vscode/test-cli`, downloaded into `apps/vscode/.vscode-test`): activation, the engine, detection, commands, the status report, the language model tools, F5's preflight. Then `test/workspace` in a workspace of several folders (`test/workspace/fixture`: the Capacitor and Flutter samples and a folder with no app): each folder's apps, Run and Debug's entries per folder, the current app following the open file until one is picked. Then `test/skill`, a first install: two copies of the Capacitor sample in a temporary folder, each its own repository (one with a different skill named capmac), and a home folder (`USERPROFILE`, `CLAUDE_CONFIG_DIR`…) where only Claude Code is set up: the skill lands in both projects, the other skill stays, a removed copy stays removed, `capmac` runs from the extension host. The first two runs set `capmac.agents.addSkill` to `off` in their profile, since the samples are inside this repository (the skill would go at its root).
- By hand (and with CDP): open `apps/vscode` in VS Code and press F5. Driving a VS Code started with `--remote-debugging-port` from playwright-core works well; set `"window.dialogStyle": "custom"` so modal dialogs are in the page (native ones are not).

Verified end to end on a real Mac (2026-10-16): Capacitor run and live reload on an iPhone simulator, the H.264 screen with touch and typing, Problems from an Xcode error, Debug Console commands, screenshots; an Electron app's window; Flutter's iOS app (hot reload, hot restart) and Mac app (hot reload); the Windows app's Visual Studio prompt; the keychain password prompt; pairing discovery; health checks; the installed `.vsix`.

React Native and Capacitor's two extra run options arrived with their branches' merge into main (2026-10-17), switched on by `contract.ts` as planned:

- React Native: runs of its iOS, Mac and Windows apps, Metro as the first step ("Metro", "Packages and pods", Studio's order), `r`/`R`/`b` as reload/relaunch/rebuild, React Native DevTools (`j` in the Debug Console, a button on the debug toolbar and the Run view, `capmac.devtools`; `__CAPMAC_HAS_DEVTOOLS__` reads `sessions.devtools` from `contract.ts`), *Run in Release Mode* (`options.configuration: 'Release'`, also a dynamic debug configuration), its sample (`reactNativeSampleDir`, `dist/samples/hello-react-native`).
- A Capacitor app's *Run without Building the Web App* (`options.webBuild: false`) and *Sync to the Mac* (`sessions.start` mode `sync`), in the Run view's menu and the command palette.

Checked on main after the merge: 31 unit tests (Studio's real host finds the React Native sample's three apps) and 10 integration tests; live on a real Mac, Sync and Run without building of the Capacitor sample, and the React Native sample in Live on an iPhone simulator (Metro, the app's `js` and `app` logs, its screen in the tab, Stop, Metro gone after).

Activation: `workspaceContains` takes a pattern as a glob only when it has `*` or `?`, so a root pattern with braces alone (`metro.config.{js,ts}`) never matches; React Native folders activate on `metro.config.*`, Expo ones on `app.config.js|ts` or `eas.json` (else when the CapMac view opens). The patterns go two folders down (`*/*/capacitor.config.{json,ts,js}`): a monorepo's `apps/mobile` activates too (detection itself looks three levels down).

Workspaces of several folders (checked live 2026-10-17 on IK's M1): three samples side by side, the Capacitor sample beside a web site, notes, a Cordova and a Tauri app (shown as not supported yet), only unsupported folders (the Run view says "these folders"), one folder holding several projects, and a monorepo. The current app follows the open file until one is picked in the Apps view; React Native Live and a Capacitor Run ran at once from two folders, each in its own debug session and Debug Console, and the Apps view marks every app that runs (the model remembers which app each session was started for: the engine's events name only the project).

Studio parity (2026-10-18, checked live on IK's M1 in a test VS Code driven over CDP): the Mac tooltip with the health check's probe (macOS, Xcode, chip, simulators) and the paired date, Copy UDID from a simulator's menu, Build an IPA's options (the Team ID checked, saved in capitals, cleared again), the remote access commands up to the server question (no server here to go further), the sync size in the Apps view, the skill added to a project and removed again, the `capmac.problems.packageWarnings` setting. Not checked live: remote access with a server, an IPA upload, a run on this PC without building

Left out on purpose: Studio's takeover of another CapMac's run (VS Code's debug sessions own their runs), its console view (the Debug Console is that) and its keyboard shortcuts (VS Code's keybindings are the user's)

## Not done yet

- Publishing to the Marketplace (needs a publisher account; the `publisher` field is a placeholder) and per-architecture `.vsix` files (the WebRTC module for remote access is most of the size).
- A real JavaScript debugger: Electron apps already expose the DevTools protocol on the Mac, which could be tunnelled to VS Code's `js-debug`; Flutter's VM service could be handed to the Dart extension.
