# capmac Studio: a real-time simulator, touch without AXe, a signed installer that updates itself

## Context

You're picking up **capmac** in `C:\Users\ik\Documents\GitHub\capacitor-xtool`: a "Pair to Mac" tool for Capacitor apps. From Windows it builds, runs, live-reloads and shows a Capacitor iOS app on a Mac over SSH. Two front ends share one engine:

- the **CLI** (`packages/cli`, published as `capmac`);
- **capmac Studio** (`apps/desktop`), a Windows desktop app (Electron 44, React 19, Vite 8).

The previous session built capmac Studio, reviewed every screen in light and dark, packaged it, and verified it end to end on my real Mac. It also ran a **streaming v2 spike**: H.264 straight from the simulator's framebuffer. You have no memory of those sessions; everything you need is below and in the repo.

**Your job this session**, in this order:

1. **Streaming v2 in the product.** Make the simulator pane real-time: H.264 from the Mac, decoded with WebCodecs on Windows. Today's JPEG stream becomes the automatic fallback.
2. **Input through the same helper.** Taps, drags, scrolling, typing and hardware buttons, so AXe is no longer needed.
3. **Code signing** for the Windows builds.
4. **Auto-update** for the installed app.

Parts 1 and 2 are the heart of the session. Parts 3 and 4 need decisions and credentials from me: prepare everything so that I only have to provide them.

## Ground rules

- **Work autonomously.** Ask me only when you truly need me: my Mac password; installing software on the Mac or globally on this PC; plugging in or unlocking my iPhone; a signing certificate or an Azure account; where releases are hosted; or a product decision this brief doesn't answer.
- **Test against my real Mac** (already paired). Don't build fake Macs or mocked Xcode environments.
- **Never kill processes you didn't start.** I run many unrelated Vite/Node dev servers on this PC. Another project owns `127.0.0.1:5173`, and another process owns port 9333.
- **Ask before installing.** Nothing on the Mac (for example AXe via Homebrew). Nothing globally on this PC (`npm -g`, `npm link`, Playwright's browser downloads). Compiling capmac's own helper on the Mac with the installed Xcode, into `~/.capmac`, is allowed; it's like the agent upload.
- **Don't install capmac Studio on this PC** without asking: the installer adds Start menu entries and an uninstaller. For checks, use the unpacked build or the portable exe, or Windows Sandbox if I enable it for you.
- **Fetch current docs with the ctx7 CLI**: Electron, electron-builder, electron-updater, WebCodecs, VideoToolbox, Playwright. It's late 2026 and these move fast.
- **Keep everything green:**
  - `npm test` (112 tests), `npm run typecheck`, `npm run build`;
  - `npm run desktop:test` (2 Playwright smoke tests on the built app);
  - `node bin/capmac.js run` and `dev` in `examples/hello-capacitor` still work on the Mac.
- **Git:** commit at the end of each milestone on `master`. Don't push.
- **Secrets:** never commit or store passwords, certificates or tokens. Signing credentials come from environment variables at build time.
- **Errors:** every error says what happened and how to fix it, never a raw stack trace.
- **Never call `setPowerState:` on a simulator screen.** See the hard-won facts.

## Where things stand (read first)

- **`docs/desktop-design.md`.** §3 is the architecture, §4 the engine API, §5 streaming v2: the design, the spike results, the recommendation and its risks.
- **`spikes/streaming-v2/`.** See its README.
  - `simstream.m` is the working helper: SimScreen frame callbacks → framebuffer IOSurface → VideoToolbox H.264 → length-prefixed frames on stdout, plus keyframe, clock-ping and quit commands on stdin.
  - `bench.ts` builds the helper on the Mac and measures v1 and v2.
  - `decode-test.mjs` decodes a recorded stream with WebCodecs inside the running app.
  - `tools/introspect.m` and `tools/mac.ts` explore the private API on the Mac.
- **`README.md`**: features and the scripts.
- **Workspace layout:**
  - `packages/core` (`@capmac/core`, private, TypeScript source): the engine (`src/engine`), the Mac agent (`src/agent`) and the wire protocol (`src/shared`).
  - `packages/cli`: the CLI. Its esbuild bundle inlines core.
  - `apps/desktop`:
    - `src/main`: windows, tray, notifications, IPC validation.
    - `src/preload`: a minimal typed bridge.
    - `src/engine/host.ts`: the engine in a `utilityProcess`.
    - `src/renderer`: the React UI.
    - `src/shared/contract.ts`: every IPC payload, zod-validated.
- **The screen stream today (v1), end to end:**
  1. **Agent op `screen`** (`packages/core/src/agent/ops/screen.ts`). It loops `simctl io <udid> screenshot --type=jpeg` plus a `sips` resize and sends the JPEGs as binary frames. It also takes input through AXe and reports screen info (size, scale, whether input works).
  2. **`ScreenStream`** (`packages/core/src/engine/screen.ts`). It runs the op over a `MacLink`, restarts it after a reconnect, and reports `streaming` / `reconnecting`.
  3. **`openScreen`** in `apps/desktop/src/engine/host.ts`. It uses one `MessagePortMain` per stream, with ack-based flow control (at most 2 frames in flight). Input is validated with `inputEventSchema` (normalized 0–1 coordinates).
  4. **The renderer.** `workers/screen.worker.ts` decodes the JPEGs with `createImageBitmap` onto an OffscreenCanvas. `features/workspace/Simulator.tsx` draws the device frame, maps pointer events, and shows the overlays (connecting, reconnecting, ended) and the footer stats.
  5. **The CLI's browser viewer** (`packages/cli/src/viewer/`) uses `ScreenStream` too.
- **The agent.** `packages/core/scripts/agent-build.mjs` bundles it deterministically. It's uploaded to `~/.capmac/agent/<hash>/` and runs once per operation on its own SSH exec channel. Closing the channel cancels the operation.
- **Dev workflow:**
  - `npm run desktop:dev` runs Vite, an esbuild watch and Electron, with a debugging port on 39217 (`CAPMAC_DEV_DEBUG_PORT`). Renderer changes hot-reload. Main, preload or engine changes restart Electron, which ends running sessions.
  - **Drive the app:** `node apps/desktop/scripts/tools/drive.mjs "click:…" "eval:…"` uses Playwright `connectOverCDP`.
  - **Screenshots exactly as on screen**, Mica included: `powershell -ExecutionPolicy Bypass -File apps/desktop/scripts/tools/capture.ps1 -Out shot.png`.
  - **A second, isolated instance** (fresh profile, no Macs):
    - set `CAPMAC_STUDIO_USER_DATA` and `CAPMAC_CONFIG_DIR` to temp folders, and `ELECTRON_RENDERER_URL` to the dev Vite URL;
    - run `node_modules/electron/dist/electron.exe .` from `apps/desktop`;
    - stop it with `taskkill /T /F`: closing its window only hides it to the tray.
  - **Browser checks:** Playwright with `channel: 'msedge'`.
  - **Testing reconnects:** the palette command "Developer: drop the connection to the Mac" (development builds).
- **Verified on the Mac last session:**
  - the CLI: `run` reaches the app in 16 s; `dev` delivers a web edit in 0.9 s and rebuilds a native edit in 5.4 s;
  - pairing, health checks, Run, Live with HMR;
  - a Swift error opens Problems at the line;
  - a dropped connection reconnects, restores the session and resumes the stream;
  - the tray, notifications, the packaged app and the portable exe.
- **Not verified:**
  - physical device runs and `.ipa` export (they need the keychain password);
  - touch input (AXe isn't installed);
  - the installed NSIS app.
- **Screenshot gallery** (private): https://claude.ai/artifact/UQGHnBvBevFxYLDJMiaeBW. Update it in place with the Artifact tool and its `url` when screens change.

## The Mac (already paired)

- **Connection:** alias `ik-s-m1` → `ik@IKs-M1.local`. The config is `%USERPROFILE%\.capmac\config.json` and the key `%USERPROFILE%\.capmac\id_ed25519`.
- **Setup:**
  - An Apple silicon MacBook Pro ("IK's M1"), macOS 26.6.1, Xcode 26.6 (Swift 6.3.3, clang available through `xcrun`).
  - iOS 26.5 and 16.4 simulators, 28 devices. "iPhone 17" (`D100855D-E944-4869-9CFB-2BA359E77151`) is the default target and is usually booted headless: Simulator.app isn't running.
  - Node 24 at `/usr/local/bin/node`, CocoaPods 1.16.2, `python3` available.
  - Two displays, on, with display sleep disabled.
- **Limits:**
  - AXe isn't installed.
  - The login keychain is locked over SSH.
  - The iPhone "IK 14 Pro Max" (iOS 26.6.2, Developer Mode on) is paired but usually unplugged.
- **Health check:** `node ../../bin/capmac.js doctor` from `examples/hello-capacitor`.
- **The sample** (`examples/hello-capacitor`, and the app's copy in `%USERPROFILE%\Documents\capmac Studio\Hello capmac`) has a "Tapped N times" button that logs `Counter: N`. Use it to verify taps. Add a text field and a scrollable list to the repo's sample if you need them for typing and scrolling tests.

## Hard-won facts (don't relearn these)

### Streaming (Xcode 26.6, verified)

- **Display ports are `SimScreen` objects.** They're ROCKit remote proxies: `SimDevice.io.ioPorts[].descriptor`. Register with `registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:`:
  - `frameCallback` is `void (^)(void)`, called once per rendered frame;
  - `surfacesChanged` is `void (^)(IOSurface *framebuffer, IOSurface *masked)`;
  - `propertiesChanged` is `void (^)(id<SimScreenProperties>)`.

  The older `SimDisplayRenderable` damage callbacks still exist but never fire.
- **Pick the device's own screen:** the one whose `screenProperties.screenType` is 0, the LCD. After a reboot, "TVOut" (type 1, powered off) came first in the port list.
- **Read the framebuffer** from `framebufferSurface`, an IOSurface (BGRA, 1206×2622 on iPhone 17). Wrap it with `CVPixelBufferCreateWithIOSurface`, then convert and scale with `VTPixelTransferSession` into the encoder's NV12 pool.
- **The helper's main thread runs `CFRunLoopRun()`.** That works. `dispatch_main` wasn't retested after the switch to SimScreen.
- **Keep dispatch timers in statics.** Under ARC with `-O2`, a timer held only in a local variable is released after its last use and stops firing.
- **Rate control.** Standard rate control (`RealTime`, `AllowFrameReordering = false`, High profile, 6 Mbps average) keeps 55–60 fps under full-screen motion. VideoToolbox's low-latency rate control at 6 Mbps dropped about half the frames, and only reached 60 fps at 12 Mbps, with more latency.
- **Measured** (the Mac to this PC on the LAN, round trip 7–20 ms; v1 is today's JPEG stream):

  | | v1 | v2 |
  |---|---|---|
  | Frame rate | about 4 fps | 55–59 fps |
  | Capture to arrival | about 300 ms | p50 18–19 ms, p95 30–41 ms |
  | Bandwidth | 2.5–3.6 Mbps | 0.3 Mbps (partial updates), 4.3 Mbps (full screen) |
  | Idle screen | screenshots keep coming | nothing |

  WebCodecs decodes `avc1.640028` (with the avcC record as `description`) in 0.5 ms per 642×1398 frame in hardware, 2.8 ms in software.
- **One unexplained failure.** Once, before a simulator reboot, the main screen accepted the callbacks but its framebuffer never updated (the IOSurface seed stayed constant), while `simctl io screenshot` kept working. After `simctl shutdown` and `boot`, it worked every time over dozens of runs. Hence the fallback, and a "Restart the simulator" recovery action.
- **Never call `setPowerState:`.** It takes 0 (off) or 1 (on). Passing 2 turned the display off, and iOS stayed black until a reboot.
- **Checking whether the simulator renders at all:** Apple's `simctl io <udid> recordVideo --codec=h264 file.mov` works headless and captures about 60 fps. Count its frames with AVFoundation.
- **Simulator.app:** opening it on a headless-booted device and quitting it again shuts that device down. Over SSH, `osascript … quit` does nothing (no Automation permission); `kill -TERM` works.
- **Electron:** `MessagePortMain` can't transfer ArrayBuffers, so the engine copies each frame once. The renderer side moves frames on to the worker without copying.

### Input (Xcode 26.6: the symbols are verified, the signatures are not)

- **`SimulatorKit.SimDeviceLegacyHIDClient`** has `initWithDevice:error:`, `initWithDevice:sessionResetQueue:error:sessionResetHandler:`, `resetHIDSession`, and `sendWithMessage:freeWhenDone:completionQueue:completion:`, which takes an `IndigoHIDMessageStruct *`. The struct's union includes touch, pointer, button, wheel and keyboard events.
- **SimulatorKit exports C builders:**
  - `IndigoHIDMessageForMouseNSEvent`, `IndigoHIDMessageForButton`;
  - `IndigoHIDMessageForKeyboardArbitrary`, `IndigoHIDMessageForKeyboardNSEvent`, `IndigoHIDMessageForModifierKeyBit`;
  - `IndigoHIDMessageForHIDArbitrary`, `IndigoHIDMessageForScrollEvent`, `IndigoHIDMessageToCreatePointerService`, and more.

  The symbol table doesn't give their parameters. Derive them from idb (FBSimulatorControl's `FBSimulatorIndigoHID.m`, MIT) and from baguette's notes on the iOS 26 nine-argument mouse message, then confirm by experiment against the sample app.
- **Xcode 27 removes legacy Indigo HID**; idb moved to DTUHID. Detect what's available at runtime, keep AXe as a fallback when it's installed, and keep view-only as the last resort, with a reason.
- **Coordinates:** the pane already sends normalized 0–1 coordinates; AXe takes points.

### Windows and Electron

- **`ELECTRON_RUN_AS_NODE=1`** is set in VS Code terminals: strip it when launching Electron. Packaged builds ignore it, because the `runAsNode` fuse is off.
- **NTFS last-access updates are on**, so `fs.watch` reports reads. The live-reload watcher compares size and mtime (`packages/core/src/engine/watch.ts`).
- **Node reports `app:`, `file:` and `data:` URLs with the origin "null".** Compare scheme, host and port with `sameOrigin` (`apps/desktop/src/shared/urls.ts`).
- **Mica:** text over transparent layers gets grayscale antialiasing, so dense text (the console) sits on an opaque surface.
- **No `node_modules` are shipped:** `app.asar` holds `out/` and `package.json` only, and main, preload and the engine are esbuild CommonJS bundles. Any new runtime dependency, such as electron-updater, must bundle cleanly into them.
- **electron-builder 26.15.3:**
  - `npmRebuild` is top-level;
  - per-architecture artifacts need `buildUniversalInstaller: false` on both `nsis` and `portable`;
  - `win.azureSignOptions`, `win.signtoolOptions` and `win.verifyUpdateCodeSignature` exist.

  The "signing with signtool.exe" log lines are no-ops without a certificate: every current exe shows `NotSigned` in `Get-AuthenticodeSignature`.
- **Identity:** `appId` / AUMID is `dev.capmac.studio`, and the product and executable name is "capmac Studio". Windows notifications already work from the dev build.

## What to build

### 1. Streaming v2 with automatic fallback

Follow the recommendation in `docs/desktop-design.md` §5:

- **Build the helper on the Mac.**
  - Ship `simstream.m` inside the agent bundle (an esbuild text loader).
  - On first use, compile it with `xcrun clang` into `~/.capmac/bin/<hash>/simstream`. The hash covers the source and the Xcode version.
  - Cache the result. A compile failure becomes the fallback's reason, with the compiler's message available in the details.
- **Add an agent op `stream`.**
  - It ensures the helper and starts it for the UDID.
  - It relays the helper's frames as binary agent frames, without transcoding.
  - It forwards keyframe requests and (part 2) input on stdin, and reports screen info in points and scale, as `screen` does.
  - When cancelled, it stops the helper: no orphans, ever.
- **Engine: `ScreenStream` gets a codec, `h264` or `jpeg`.** Prefer H.264 and fall back to JPEG when:
  - the helper can't build or start;
  - it exits;
  - no frame arrives within about 1.5 s of a forced keyframe;
  - or the screen evidently changes while the H.264 stream is silent (the unexplained failure above).

  Design and test a cheap detector for the last case. One idea: the helper reports its frame count and the surface seed once a second, compared with an occasional small screenshot hash.

  Force a keyframe at start, after a reconnect, on a decoder error and on request.
- **Renderer worker:**
  - Use WebCodecs `VideoDecoder`: the codec string comes from the avcC record, which is also the `description`; set `hardwareAcceleration: 'prefer-hardware'` and `optimizeForLatency: true`.
  - Draw each `VideoFrame` to the OffscreenCanvas, then `close()` it.
  - Under backpressure, drop delta frames up to the next keyframe and request one. Never drop arbitrary H.264 frames in the engine.
- **UI:**
  - The footer reads "60 fps · 1.2 Mbps", plus a quiet "Compatible stream" note with its reason after a fallback.
  - Add a setting: "Simulator stream: Smooth (H.264) / Compatible (screenshots)".
  - The Macs health check reports the helper's state ("built for Xcode 26.6") or why it can't build.
- **Robustness:**
  - The helper's memory stays flat over 30 minutes; check its RSS. AXe's video leak is the cautionary tale.
  - The helper exits when its stdin closes.
  - No helper processes remain on the Mac after a stop, a reconnect or an app quit (`pgrep simstream`).
- **Optional:** v2 in the CLI's browser viewer.

**Acceptance (sample app with a 60 Hz animation):**

- 50 fps or more in the pane;
- capture-to-decode p95 under 60 ms on the LAN;
- 0 kbps while the screen is idle;
- no more than 8 Mbps under full-screen motion;
- a dropped connection shows the last frame dimmed, then resumes with a keyframe;
- a forced fallback shows the compatible stream and its reason;
- no DevTools errors;
- PC CPU near idle while the screen doesn't change.

### 2. Touch, keyboard and buttons through the helper

- **Commands.** The helper takes input commands on stdin: touch down/move/up (one finger, two for pinch as a stretch goal), scroll, text, key, and buttons (home, lock, Siri, side). Inject them through `SimDeviceLegacyHIDClient` with Indigo messages. The engine already validates input; the helper clamps it too.
- **Pane behaviour:**
  - Stream pointer down, move and up as touches, so scrolling and dragging feel natural; don't synthesize gestures after the fact.
  - Typing on the focused screen sends keys.
  - Pasting sends text.
  - The toolbar buttons work.
  - The tap ripple stays.
  - Cancel any touch still down on disconnect or blur: no stuck fingers.
- **Text.** Map Windows key events to HID usages. For non-ASCII text, use the simulator pasteboard (`xcrun simctl pbcopy`) and paste. Pick what works reliably.
- **AXe.** Drop "View only · Install AXe…" when helper input works. Keep AXe as the fallback if it's installed, and view-only with a reason as the last resort.

**Acceptance:**

- tapping the sample's button increments the counter (`Counter: N` in the console);
- scrolling works (Settings, or a list in the sample);
- typed text appears in a text field;
- home and lock work;
- click to visible change in the pane under about 100 ms on the LAN.

### 3. Code signing

- **Sign everything electron-builder produces:** the app exe, the installer and uninstaller, `elevate.exe` and the portable exe, all timestamped. SmartScreen's trust depends on it, and auto-update verification relies on it.
- **Bring me a short decision note, with costs and effort:**
  - Azure Trusted Signing (`win.azureSignOptions`): an Azure subscription plus identity validation;
  - or an OV/EV certificate (`CSC_LINK` and `CSC_KEY_PASSWORD`, or a hardware token).
- **Configure signing entirely through environment variables.** Unsigned local builds must keep working when they're absent.
- **Document it** in the README.
- **Verify** with `Get-AuthenticodeSignature` once I provide credentials.

### 4. Auto-update

- **Use electron-updater** (check the current version with ctx7) for the NSIS build. The portable build can't update itself: show "Version X is available" with a link instead.
- **Ask me where releases live.** Options: GitHub Releases (it needs a remote and a publish token) or a generic HTTPS bucket. Build against a configurable generic provider so the host is a one-line change. Differential updates use the `.blockmap` files the build already makes.
- **The experience is calm, and never interrupts a running session:**
  - check at startup and every few hours, and download in the background;
  - Settings › About shows the version, "Check for updates", the status and a release-notes link;
  - when an update is ready, show an InfoBar ("capmac Studio 0.2.0 is ready · Restart to update") and a tray menu item;
  - if a session is running, install on quit.
- **Verify without installing on my PC.** Serve `latest.yml`, the installer and the blockmap from a local HTTP server, and use the unpacked build with `forceDevUpdateConfig` / `dev-app-update.yml`. A full install-then-update test needs my OK (or Windows Sandbox).
- **`verifyUpdateCodeSignature`** depends on part 3. Until signing is in place, document the risk.

## Deliverables for this session

1. **Streaming v2 in the app**, with automatic fallback. Measure it through the real app path (engine → port → worker), not only the bench, and update `docs/desktop-design.md` §5.
2. **Input through the helper**, verified on the sample: tap, scroll, type, buttons. AXe becomes optional.
3. **Code signing:** the configuration, the docs, and the decision note for me. A signed build verified, if I gave you credentials.
4. **Auto-update:** implemented and verified locally, with my hosting decision asked for.
5. **Tests:**
   - unit tests for the frame protocol, the codec string, the fallback decisions and the input mapping;
   - Playwright smoke tests still green;
   - everything re-verified on the Mac.
6. **Screenshots, light and dark, of what changed:**
   - the pane streaming, with the footer stats;
   - the fallback state;
   - input in action;
   - Settings (stream, About and updates);
   - the update InfoBar.

   Review them critically, iterate, and update the gallery.
7. **A short summary:**
   - what works, verified on the Mac;
   - the screenshots;
   - what needs me;
   - what's next.

## Quality bar

- **It feels like a local simulator:** smooth, crisp, with instant touch.
- **Never worse than today:** any failure falls back to the compatible stream, with a reason, never a black pane.
- **Clean:** no DevTools errors, no leaks (the helper's memory stays flat), no orphaned processes on either machine.
- **Every state is designed:** building the helper, streaming, fallback, reconnecting, input unavailable, update available, update ready.
- **Keyboard and screen reader friendly.**

## How to work

1. **Read:**
   - `docs/desktop-design.md` §5 and `spikes/streaming-v2/README.md`, then `simstream.m`;
   - `packages/core/src/agent/ops/screen.ts` and `packages/core/src/engine/screen.ts`;
   - `openScreen` in `apps/desktop/src/engine/host.ts`;
   - `apps/desktop/src/renderer/workers/screen.worker.ts` and `features/workspace/Simulator.tsx`;
   - `apps/desktop/src/shared/contract.ts`.
2. **Check that everything runs.** Run `npm install`, `npm test`, `npm run typecheck`, `npm run build` and `npm run desktop:test`. Then run `node ../../bin/capmac.js doctor` from `examples/hello-capacitor`, and boot the iPhone 17 if it isn't booted.
3. **Reproduce the spike numbers** with `spikes/streaming-v2` (`build`, then `v2` and `v1`) before you integrate anything.
4. **Work milestone by milestone:** streaming v2 with fallback, then input, then signing, then auto-update. Verify each on the Mac and commit it.
5. **Finish with the summary.**
