# CapMac Studio — design

CapMac Studio is the Windows desktop app for CapMac. It does what the CLI does: pair with a Mac, then build, run, live-reload and see a Capacitor iOS app on it. It adds the views a terminal can't give you: a live simulator, a build timeline, clickable problems, and a console you can filter. It is built to grow into a full remote iOS Simulator for Windows.

This document covers:

1. Product: principles, information architecture, the screens and their states.
2. Visual language: tokens, type, spacing, motion, and the component inventory.
3. Architecture: the engine, the CLI and Electron.
4. The engine API.
5. Simulator streaming v2: the plan, the spike and the recommendation.
6. Remote access: reaching the Mac over the internet.
7. Electron apps on the Mac: running, showing and live-reloading them without taking over the Mac.

---

## 1. Product

### Principles

- **Calm by default.** Most of the time nothing is happening. The idle UI is quiet: no spinners, no polling, near-zero CPU. Motion and colour only show up when something changes state.
- **One loop, one click.** The core loop is: open project → **Live** → the app appears → edit in VS Code → it updates. Everything else supports that loop, and nothing gets in its way.
- **Every state is designed.** Loading, empty, offline, reconnecting, failed and cancelled all have their own state. Every error says what happened and how to fix it, often with a button that does the fix. Raw stack traces never reach the UI. Engine errors carry `message`, `hint` and `details`; anything unexpected becomes "Something went wrong in CapMac", with a "Copy details" button.
- **Native to Windows 11.** The app uses a Mica backdrop, Segoe UI Variable, the user's accent colour and the system caption buttons with snap layouts. Focus rectangles follow Fluent. The tray icon and toast notifications work as Windows users expect.
- **Keyboard first.** Every action is reachable from the command palette (Ctrl+K) and most have a shortcut. Full screen-reader support.
- **The terminal stays first-class.** The CLI and the app share one engine, so they can't drift apart, and the CLI keeps working on its own.

### Name

The working name **CapMac Studio** is clear and continuous with the CLI, and the code uses it. Alternatives, if you want one:

- **Ferry**: it carries your app across to the Mac.
- **CapMac Desktop**: plain, like GitHub Desktop.

"Studio" slightly suggests an editor, which this isn't.

### Information architecture

```
CapMac Studio
├── First run (also "Pair a Mac" later)
│   ├── Welcome
│   ├── Prepare your Mac ........ Remote Login on, stay logged in to the desktop
│   ├── Find your Mac ........... Bonjour discovery (firewall note first) or type an address
│   ├── Sign in ................. user + password once, host-key fingerprint to trust
│   ├── Health check ............ live doctor checklist with one-click fixes
│   └── You're set .............. "Run the sample app": the success moment
├── Home ........................ recent projects, add (picker / drag & drop), sample app
├── Workspace (one per project)
│   ├── Toolbar ................. Mac ▾ · Target ▾ · Run · Live · Stop · Build IPA · Open in Xcode · ⋯
│   ├── Session bar ............. live-mode card, reconnect banner, run status
│   ├── Simulator pane .......... canvas, device frame, touch, keyboard, Home/Lock, screenshot
│   ├── Timeline pane ........... Web build → Sync → Dependencies → cap sync → Xcode build → Boot → Install → Launch
│   └── Console | Problems ...... virtualized console; diagnostics with code excerpts
├── Devices ..................... simulators by runtime (boot/shut down) + devices (connection, Developer Mode)
├── Macs ........................ paired Macs, live status, health per Mac, unlock keychain, pair another
└── Settings .................... appearance, editor, console, builds, notifications, about
Global: title bar (breadcrumb + command search), command palette, dialogs (password,
confirm, host key, Build IPA), toasts, tray icon, Windows notifications.
```

The **sidebar** has:

- **Home**, then the **Projects** group (up to six recent projects, each with its icon and a status dot when running).
- **Devices** and **Macs**.
- At the bottom: a **Mac status chip** (the default Mac, connection state and round-trip time), then **Settings**.

The sidebar collapses to a 52 px rail (Ctrl+B).

### Screens

Wireframes use these markers:

- `▸` button
- `●` status dot
- `▾` picker
- `⋯` overflow menu

#### Title bar (40 px, drawn by the app; caption buttons are native)

```
┌──────────────────────────────────────────────────────────────────────────────┬──────────┐
│ ◆ CapMac Studio › Hello CapMac       [ 🔍 Search or run a command   Ctrl+K ]   │ ─  ▢  ✕ │
└──────────────────────────────────────────────────────────────────────────────┴──────────┘
```

The whole bar is a drag region except the controls. The caption buttons come from `titleBarOverlay`, so their colours follow the theme and Windows 11 snap layouts work. The search box opens the command palette.

#### First run

The flow is a centred column, 520 px max, on Mica. A thin step indicator sits at the top, and each step ends with a primary action on the right.

1. **Welcome.** Headline: "Build and run your iOS app from Windows". The illustration shows a PC linked to a Mac with an iPhone. "Get started ▸". If the CLI already paired a Mac, first run is skipped.
2. **Prepare your Mac.** Two cards, each with a short explanation:
   - "Turn on Remote Login": System Settings › General › Sharing.
   - "Stay logged in": simulators need a desktop session.

   A note warns that Windows may ask to let CapMac Studio find devices on the network: allow it on private networks. This note comes before the first scan, which binds UDP 5353. "Find my Mac ▸".
3. **Find your Mac.** A radar-style scanning indicator, then a list of discovered Macs with name, host and IP. "Enter an address instead" reveals a text field. Empty state: "No Macs found" with the likely causes (Remote Login off, different network or VPN, the firewall prompt was declined), plus "Scan again" and manual entry.
4. **Sign in.** The Mac's name, a user name field (with a hint: "the short name from `whoami`") and a password field: "used once to install CapMac's key, never stored". On the first connection, a dialog shows the host-key fingerprint: "Trust this Mac?". Progress runs as a checklist:
   1. Connecting.
   2. Installing key.
   3. Inspecting the Mac.
   4. Checking Xcode.
5. **Health check.** The doctor checklist streams in. Failing items get a fix button:
   - Install Node.js (private copy).
   - Accept the Xcode licence (asks for the sudo password).
   - Download the iOS platform.
   - Install CocoaPods or AXe (asks for confirmation).

   Warnings never block "Continue".
6. **You're set.** The success moment: "Run the sample app ▸". It copies the bundled sample to `Documents\CapMac Studio\Hello CapMac`, opens its workspace and starts Run. Under 2 minutes from install to an app on the simulator. A secondary action: "Open my own project".

#### Home

```
Projects                                                    [▸ Add project  Ctrl+O]
┌───────────────────────────┐ ┌───────────────────────────┐ ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│ [icon] Hello CapMac   ● Live│ │ [icon] Shop               │   Drop a Capacitor app
│ dev.capmac.hello           │ │ com.acme.shop             │ │ folder here         │
│ SPM · 142 files · 1.2 MB   │ │ CocoaPods · 2.3k · 18 MB  │   or browse…
│ Ran 2 min ago on iPhone 17 │ │ Ran yesterday on iPhone…  │ └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
└───────────────────────────┘ └───────────────────────────┘
```

- Cards show:
  - the app icon from `AppIcon.appiconset`, masked to the iOS squircle;
  - name and app id;
  - the iOS package manager badge;
  - sync size: files and bytes the sync would send, computed in the background;
  - the last run.
- Hovering a card reveals Run and Live buttons and a ⋯ menu: Open folder, Open in VS Code, Remove from list.
- Empty state: an illustration, "Add your Capacitor app", the drop zone, and "Try the sample app".
- Dropping a folder anywhere in the window adds it. If the folder isn't a Capacitor app, a toast explains why (no `capacitor.config.*`).

#### Workspace

```
┌ [icon] Hello CapMac   [IK's M1 ▾] [● iPhone 17 · iOS 26.5 ▾]     [▸ Run] [⚡ Live] [■] │ [Build IPA] [Xcode] ⋯ ┐
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⚡ Live  http://localhost:5173 ⟶ tunnel ⟶ IK's M1   ● HMR connected · updated 12:04:31   [↻ Rebuild] │
├───────────────────────┬──────────────────────────────────────────────────────────────────────────────┤
│                       │ Timeline                                               Run #4 · 6.2 s         │
│   ╭───────────────╮   │ ✓ Sync 0.4s  ✓ Deps (unchanged)  ✓ cap copy 0.9s  ○ Xcode (native unchanged) │
│   │               │   │ ✓ Boot (running)  ✓ Install 1.1s  ✓ Launch 1.6s                               │
│   │   simulator   │   ├──────────────────────────────────────────────────────────────────────────────┤
│   │    canvas     │   │ [Console] [Problems 2]   JS Capacitor Native Bridge │ Level ▾ │ 🔍 search   ⏸ ⋯ │
│   │               │   │ 12:04:31.204  JS   Hello from CapMac                                         │
│   │               │   │ 12:04:31.207  JS ▸ {device: {…}, ready: true}                                 │
│   ╰───────────────╯   │ 12:04:32.010  iOS  WebContent process launched                               │
│ [⌂][⏻][⌨][⤓] 5.1 fps  │                                                     ↓ 23 new lines          │
└───────────────────────┴──────────────────────────────────────────────────────────────────────────────┘
```

- **Toolbar**
  - **Mac picker**: the paired Macs with state, plus "Pair a Mac…".
  - **Target picker**: a searchable combobox.
    - Booted simulators come first, then the rest grouped by runtime, then devices.
    - Each entry shows its state live: Booted, Shut down, or connected by USB / Wi-Fi.
    - Devices that need attention say why: Developer Mode off, locked, not paired.
  - **Run** (Ctrl+F5) builds and launches with logs attached.
  - **Live** (F5) runs the dev server and reverse tunnel, and rebuilds on native changes.
  - **Stop** (Shift+F5) stops the app and tears the session down.
  - A busy Run or Live button shows a progress ring and the current phase; pressing it again cancels.
- **Session bar**: one 36 px line, shown only while a session is active.
  - **Live**:
    - dev server URL;
    - tunnel state;
    - HMR state: *connected* / *waiting* / *updated hh:mm:ss*, detected from the WebSocket upgrade through the tunnel and the dev server's `hmr update` output;
    - Rebuild (Ctrl+Shift+F5), Clean rebuild and Relaunch.
  - **Reconnecting**: an amber banner. "IK's M1 isn't answering, it may be asleep. Reconnecting… (attempt 3)". When the connection returns: "Reconnected", the tunnel is restored and the app relaunched.
- **Panes**, laid out with react-resizable-panels:
  - Simulator on the left; on the right, Timeline above Console | Problems.
  - Every split is resizable by mouse or keyboard (focused separator, arrow keys) and collapsible.
  - Layouts persist per window (`useDefaultLayout`).
  - Ctrl+1 toggles Simulator, Ctrl+2 Timeline, Ctrl+` Console, Ctrl+Shift+M Problems.
- **Timeline**
  - Phases:
    1. Web build
    2. Sync
    3. Dependencies
    4. cap sync
    5. Xcode build
    6. Boot
    7. Install
    8. Launch
  - Each phase is pending, running (spinner, live progress text such as "Compiling AppDelegate.swift"), done (duration), skipped (with the reason: "native code unchanged", "dependencies unchanged", "already booted", "served by the dev server") or failed.
  - The header shows the run number and total time. The previous run stays visible, dimmed, until the next one starts.
- **Problems**
  - Diagnostics are grouped by file (path relative to the project), errors first.
  - Each diagnostic shows its message, `line:col` and the code excerpt from xcodebuild (the source line plus caret) in a mini code block.
  - Click, or press Enter, to open it at the line in the editor chosen in Settings (VS Code and Cursor through their `vscode://file/…` and `cursor://file/…` links), or in the default app.
  - Copy (one item, or all as `file:line:col: error: …`), and "Show full build log", which downloads the Mac-side log into a read-only viewer.
  - Warnings from dependencies (Pods, Swift packages, node_modules) are collapsed under "37 warnings from dependencies".
- **Console**: virtualized (TanStack Virtual), 100k lines by default (Settings: 10k to 1M); old lines drop in chunks.
  - Source chips: JS, Capacitor, Native, Bridge, Dev server, CapMac.
  - Level menu: Errors, Warnings, Info, Debug.
  - Search with highlighted matches, a match count and F3/Shift+F3 navigation.
  - Auto-scroll pauses when you scroll up. "↓ 23 new lines" jumps back. ⏸ freezes the view.
  - Rows: timestamp, source badge, level icon, message.
    - Errors and warnings get a tinted gutter.
    - JSON in `console.log` becomes an expandable tree: arrow keys / Enter to expand, Copy value.
  - Copy (selection or all visible lines) and Export (.log).
  - Multi-line console messages are grouped into one row.

#### Simulator pane

- Frames come straight from the engine to a Web Worker over a transferable MessagePort, and the worker draws them on an OffscreenCanvas; the main thread never touches pixels.
  - **The smooth stream** (default): H.264 from CapMac's helper on the Mac, decoded with WebCodecs. See §5.
  - **The compatible stream**: JPEG screenshots, decoded with `createImageBitmap`. Chosen in Settings, or by CapMac itself when the smooth stream cannot run.
- The device frame is drawn in CSS, as a neutral rounded bezel, and can be turned off.
- **Input through CapMac's helper** (*touch* mode):
  - the pointer is a finger: down, move and up go to the simulator as they happen, so drags, scrolling and long presses behave as on the device; a ripple marks each touch;
  - Alt+drag is two fingers, mirrored around the centre, to pinch and rotate (Simulator's Option-drag);
  - the wheel and the touchpad scroll, as a finger drag that follows them;
  - typing goes to the simulator while the screen has focus, as a hardware keyboard: characters follow the PC's layout, Windows shortcuts become their iOS ones (Ctrl+C → ⌘C), and characters a US keyboard has no key for go through the simulator's pasteboard;
  - Ctrl+V pastes the PC's clipboard; Ctrl+Shift+H and Ctrl+Shift+L press Home and Lock;
  - a finger still down is lifted when the window loses focus or the stream stops.
- **Input through AXe** (*gestures* mode), when the helper's input does not work (Xcode 27) and AXe is installed: click = tap, drag = swipe, typing in bursts.
- **View only** as the last resort, with the reason in a tooltip and "Install AXe…".
- Footer:
  - Home, Lock, Type text, Screenshot (full resolution from `simctl io screenshot`; Save… / Copy);
  - frames a second and bitrate; the tooltip adds the stream, its latency, decode time and touch-to-picture time;
  - after a fallback, a quiet "Compatible stream" note: why, and *Try the smooth stream* / *Restart simulator*.
- **States**:
  - **No simulator selected:** "Pick a simulator".
  - **Shut down:** "Boot iPhone 17".
  - **Booting:** a spinner with the boot progress.
  - **First smooth stream on a Mac:** "Setting up the smooth stream for Xcode 26.6…" while CapMac compiles its helper (about two seconds).
  - **Stream lost:** retrying.
  - **Device target:** "The screen is only available for simulators".

#### Devices

- A Mac picker (shown when several Macs are paired).
- **Simulators**, grouped by runtime. Each row has a device glyph, name and OS, a state pill (● Booted / Shut down / Booting…), and these actions: Boot, Shut down, Show screen, Use for this project.
- **Devices**, each with:
  - name and model;
  - OS;
  - connection: USB, Wi-Fi, or not connected;
  - Developer Mode: On, Off ("Settings › Privacy & Security › Developer Mode"), or unknown;
  - pairing state.
- Empty state: "No iPhone connected". The steps to connect one: plug it in, or pair it over Wi-Fi in Xcode; unlock it; tap Trust.
- Live state comes from the `watch-targets` agent op. It only runs while the window is visible.

#### Macs

- Cards for each paired Mac:
  - name (`IK's M1`) and `user@host`;
  - state (● Connected · 18 ms / Connecting / Offline with the reason);
  - macOS, Xcode, chip;
  - the Default badge.
- Actions: Check health, Make default, Unlock keychain, Unpair; plus "Pair a Mac".
- Health opens the doctor checklist, live, with the same one-click fixes as first run.

#### Settings

| Section | Settings |
|---|---|
| Appearance | Theme: System / Light / Dark. Mica follows the system transparency setting. |
| Editor | Open files in: VS Code (auto-detected on PATH), Cursor, or the default app. |
| Console | Line limit (100k / 200k / 500k), timestamps, wrap long lines, show OS logs (`--os-logs`). |
| Builds | Default configuration, show dependency warnings, verbose tool output. |
| Behaviour | Notify when a build finishes in the background. Keep running in the tray when the window is closed during a session. |
| About | App, Electron, Chromium, Node and agent versions; the CapMac config folder; licences. |

### Global patterns

- **Command palette (Ctrl+K)**
  - Fuzzy search over every action, with shortcut hints.
  - Groups: Project, Session, Simulator, Navigation, Mac, App.
  - Recent commands come first.
  - Some commands open nested pickers: "Choose target…", "Switch project…", "Boot simulator…".
- **Shortcuts**

  | Keys | Action |
  |---|---|
  | F5 | Live |
  | Ctrl+F5 | Run |
  | Shift+F5 | Stop |
  | Ctrl+Shift+F5 | Rebuild |
  | Ctrl+O | Add project |
  | Ctrl+, | Settings |
  | Ctrl+B | Toggle the sidebar |
  | Ctrl+1 | Simulator |
  | Ctrl+2 | Timeline |
  | Ctrl+` | Console |
  | Ctrl+Shift+M | Problems |
  | Ctrl+F | Find in console |
  | Ctrl+L | Clear console |
  | Ctrl+Shift+S | Simulator screenshot |
- **Dialogs**
  - Password: the reason, the Mac, "never stored", and a reveal toggle.
  - Confirm.
  - Host key: the fingerprint, with how to verify it on the Mac.
  - Build IPA: export type, team, output folder, optional upload to TestFlight.
- **Toasts** (bottom right, 4 s, pause on hover) confirm actions. **InfoBars** (inline, Fluent style) report state that needs attention.
- **Tray**
  - Menu: Run «last project», Live «last project», Stop, Open CapMac Studio, Quit.
  - The icon shows a dot while a session runs.
  - Closing the window during a session keeps the app in the tray (a one-time toast says so). Otherwise closing quits.
- **Notifications**: when a run finishes or fails while the window is in the background ("Hello CapMac is running on iPhone 17 · 6.2 s" / "Build failed: 2 errors in AppDelegate.swift"). Clicking one focuses that workspace.

### Accessibility

- **Semantics:** real buttons and links everywhere. Icon-only controls have an `aria-label` and a tooltip. Landmarks: banner (title bar), navigation (sidebar), main, toolbar, and named regions for the panes.
- **Focus**
  - Visible Fluent focus rectangle: 2 px, `--focus-outer` with a 1 px inner contrast ring.
  - Focus is trapped in dialogs and restored when they close.
  - A skip link: "Skip to main content".
- **Widgets**
  - Palette and target picker: ARIA combobox with `aria-activedescendant`.
  - Console: a grid with roving focus and arrow-key navigation. Expandable JSON uses `aria-expanded`.
  - Separators: `role="separator"` and keyboard resizing (from the library).
- **Live announcements** (polite): run started, build succeeded or failed with the error count, the connection lost or restored. Rate limited so it never floods.
- **Contrast:** text contrast ≥ 4.5:1 in both themes. The accent shades are derived so that text on accent stays ≥ 4.5:1. `forced-colors` (Windows contrast themes) maps to system colours, and borders stay visible.
- **Motion:** with `prefers-reduced-motion`, slides and scales are removed and fades are capped at 80 ms. Progress spinners stay, because they carry information.

---

## 2. Visual language

Fluent, but tuned to the density and precision of Linear and Raycast. The base is Mica; content sits on a translucent layer; controls use 4 px corners and overlays 8 px.

### Colour tokens

Values follow WinUI's theme resources so the app sits naturally next to Settings and Terminal. The accent comes from the system (`systemPreferences.getAccentColor()`, kept up to date via `accent-color-changed`), and its shades are derived with CSS relative colour syntax in OKLCH.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg-solid` | `#f3f3f3` | `#202020` | Fallback when Mica is unavailable |
| `--layer` | `rgb(255 255 255 / .5)` | `rgb(58 58 58 / .3)` | Content layer over Mica |
| `--card` | `rgb(255 255 255 / .7)` | `rgb(255 255 255 / .05)` | Cards, panes |
| `--card-2` | `rgb(246 246 246 / .5)` | `rgb(255 255 255 / .03)` | Nested surfaces, code blocks |
| `--flyout` | `#fcfcfc` (+ blur) | `#2c2c2c` (+ blur) | Menus, palette, dialogs |
| `--stroke-card` | `rgb(0 0 0 / .06)` | `rgb(255 255 255 / .07)` | Card and pane borders |
| `--stroke-divider` | `rgb(0 0 0 / .08)` | `rgb(255 255 255 / .08)` | Separators |
| `--stroke-control` / `--stroke-control-bottom` | `rgb(0 0 0 / .06)` / `rgb(0 0 0 / .16)` | `rgb(255 255 255 / .07)` / `rgb(255 255 255 / .05)` | Control elevation border |
| `--fill-control` / `-hover` / `-pressed` | `rgb(255 255 255 / .7)` / `rgb(249 249 249 / .5)` / `rgb(249 249 249 / .3)` | `rgb(255 255 255 / .06)` / `rgb(255 255 255 / .08)` / `rgb(255 255 255 / .03)` | Buttons, inputs |
| `--fill-subtle-hover` / `-pressed` | `rgb(0 0 0 / .04)` / `rgb(0 0 0 / .02)` | `rgb(255 255 255 / .06)` / `rgb(255 255 255 / .04)` | Nav items, list rows |
| `--text-1` / `-2` / `-3` / `-disabled` | 90 / 61 / 45 / 36 % black | 100 / 79 / 54 / 36 % white | Text hierarchy |
| `--accent` | `oklch(from sys 0.49 c h)` | `oklch(from sys 0.80 c h)` | Accent fills (primary button, selection) |
| `--on-accent` | `#fff` | `#000` | Text on accent |
| `--accent-text` | `oklch(from sys 0.45 c h)` | `oklch(from sys 0.82 c h)` | Links, accent text |
| `--success` / `-bg` | `#0f7b0f` / `#dff6dd` | `#6ccb5f` / `#393d1b` | |
| `--caution` / `-bg` | `#9d5d00` / `#fff4ce` | `#fce100` / `#433519` | |
| `--critical` / `-bg` | `#c42b1c` / `#fde7e9` | `#ff99a4` / `#442726` | |
| `--focus-outer` / `--focus-inner` | `#000 e4` / `#fff` | `#fff` / `#000 b3` | Focus rectangle |

Console source colours, chosen for good contrast in both themes:

| Source | Hue |
|---|---|
| JS | accent |
| Capacitor | violet (`oklch(.62 .17 300)` / `oklch(.78 .12 300)`) |
| Native | neutral `--text-2` |
| Bridge | `--text-3` |
| Dev server | teal (`oklch(.58 .1 190)` / `oklch(.8 .1 190)`) |

### Typography

Segoe UI Variable: *Text* for 14 px and below, *Display* for 20 px and above. The monospace font is Cascadia Mono, falling back to Consolas. Base UI size is 13 px, for density as in Linear; forms and first run use 14 px.

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `--type-caption` | 11 / 14 | 400 | Badges, meta, timestamps |
| `--type-small` | 12 / 16 | 400 | Secondary labels, console |
| `--type-body` | 13 / 18 | 400 | Default UI text |
| `--type-body-strong` | 13 / 18 | 600 | Labels, list titles |
| `--type-body-lg` | 14 / 20 | 400 | Forms, first-run copy |
| `--type-subtitle` | 16 / 22 | 600 | Section headers, dialog titles |
| `--type-title` | 20 / 28 | 600 | Page titles |
| `--type-title-lg` | 28 / 36 | 600 | First-run headlines |
| `--type-display` | 40 / 52 | 600 | Welcome |
| `--type-mono` | 12 / 18 | 400 | Console, code excerpts, ids |

Numbers in tables, timers and counters use tabular figures (`font-variant-numeric: tabular-nums`).

### Spacing, size, radius, elevation

- **Spacing** (4 px grid): `2 4 6 8 10 12 16 20 24 32 40 48 64` → `--s-0_5 … --s-16`.
- **Control heights:**
  - 24 px: compact, inside panes;
  - 32 px: default;
  - 40 px: first-run primary buttons.

  Icons are 16 px; 20 px in navigation.
- **Layout:**
  - title bar 40 px;
  - sidebar 232 px, or 52 px collapsed;
  - workspace toolbar 48 px;
  - session bar 36 px;
  - pane header 32 px;
  - page padding 24 / 32 px;
  - content max width 1080 px for pages (Home, Macs, Settings).
- **Radius:**

  | Token | Value | Use |
  |---|---|---|
  | `--r-control` | 4 px | Buttons, inputs, chips |
  | `--r-card` | 8 px | Cards, panes, flyouts, dialogs |
  | `--r-layer` | 8 px | Top-left corner of the content layer, as in WinUI NavigationView |
  | `--r-pill` | 999 px | Pills |
  | — | 22.37 % | The iOS app-icon squircle (`--r-app-icon`), via an SVG mask |
- **Elevation:** cards have none (stroke only).

  | Token | Shadow |
  |---|---|
  | `--shadow-flyout` | `0 8px 16px rgb(0 0 0 / .14)`; `.26` in dark |
  | `--shadow-dialog` | `0 32px 64px rgb(0 0 0 / .19), 0 2px 21px rgb(0 0 0 / .15)`; `.37` / `.37` in dark |
  | `--shadow-tooltip` | `0 4px 8px rgb(0 0 0 / .14)` |

### Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 83 ms | Hover, press, colour fades |
| `--dur-normal` | 167 ms | Flyouts, tooltips, toggles |
| `--dur-slow` | 250 ms | Pane collapse, page transitions, dialogs |
| `--dur-slower` | 333 ms | Success moments |
| `--ease-out` | `cubic-bezier(0, 0, 0, 1)` | Entrances (Fluent "fast out, slow in") |
| `--ease-in` | `cubic-bezier(.33, 0, 1, 1)` | Exits |
| `--ease-standard` | `cubic-bezier(.33, 0, .67, 1)` | Position changes |
| `--ease-spring` | `cubic-bezier(.16, 1, .3, 1)` | Small playful moments (step check, ripple) |

Patterns:

- Flyouts enter with fade + 8 px slide.
- Dialogs enter with fade + scale from .96.
- Pages fade with a 12 px rise.
- A timeline step "draws" its checkmark.
- A tap leaves a ripple on the simulator.

Spinners only exist while work is running; idle CPU stays near zero.

### Component inventory

**Primitives**

| Component | Variants and notes |
|---|---|
| Button | Accent, Standard, Subtle, Danger; sm / md / lg; icon-only; busy state |
| SplitButton | Run ▾ |
| ToggleButton | |
| Input | Text, Password (reveal), Search (match count, prev/next) |
| Select | Listbox |
| Combobox | Searchable, grouped |
| Checkbox, Switch, RadioGroup, SegmentedControl | |
| Tabs | |
| Badge / Tag | |
| StatusDot | ok / busy / warn / error / idle, with an optional pulse |
| ProgressRing / ProgressBar | Determinate and indeterminate |
| Tooltip | |
| Kbd | Shortcut hint |
| Menu | Context and dropdown |
| Dialog | Modal |
| InfoBar | info / success / caution / critical, with actions |
| Toast | |
| Card, ListItem, Divider, Skeleton | |
| EmptyState | Illustration, title, body, actions |
| AppIcon | Squircle mask |
| DeviceGlyph | |
| CodeExcerpt | |
| JsonTree | |
| KeyValue | |
| Pane | Header, actions, body; collapsible |
| SplitView | react-resizable-panels |
| VisuallyHidden, LiveRegion | |

**Composites**

| Composite | Contents |
|---|---|
| TitleBar | Breadcrumb + command search |
| Sidebar | NavItem, ProjectNavItem, MacStatusChip |
| CommandPalette | |
| ProjectCard | |
| DropZone | Window-wide overlay |
| WorkspaceToolbar | MacPicker, TargetPicker, Run/Live/Stop group |
| SessionBar | LiveCard, ReconnectBanner |
| Timeline | TimelineStep |
| ProblemsList | FileGroup, DiagnosticRow with CodeExcerpt |
| Console | Toolbar, Row, JsonTree, NewLinesPill |
| SimulatorPane | DeviceFrame, ScreenCanvas, SimToolbar, Ripple |
| DevicesList | SimulatorRow, DeviceRow |
| MacCard | |
| DoctorChecklist | CheckRow with FixButton |
| PairingFlow | Step screens |
| Dialogs | PasswordDialog, HostKeyDialog, BuildIpaDialog, ConfirmDialog |
| SettingsPage | Sections |

Icons are Fluent System Icons, regular and filled, 16 and 20 px (MIT). Only the icons in use are extracted into `src/renderer/ui/icon-data.ts` (93 today), because the full package is 170 MB.

---

## 3. Architecture

```
packages/
  core/      @capmac/core (private, TypeScript source only)
    src/shared/   wire protocol, archive format, parsers (unchanged)
    src/agent/    the Mac agent, bundled to agent.mjs and uploaded on demand
    src/engine/   everything the CLI and the app share:
                  ssh, session, MacLink (reconnects), agent client, sync, project, doctor,
                  pairing, pipeline, run/live sessions, IPA export, screen stream, events
  cli/       capmac (the published npm package): commander, terminal renderer,
             prompts, key shortcuts, browser screen viewer
apps/
  desktop/   CapMac Studio (Electron 44, React 19, Vite 8)
bin/capmac.js    dev shim → packages/cli (so `node bin/capmac.js` keeps working)
test/unit/       the CLI/engine/agent tests (vitest)
apps/desktop/test/  desktop logic tests (vitest): URL trust, palette matching, console, timeline
apps/desktop/e2e/   Playwright _electron smoke tests (built app, fresh profile)
spikes/streaming-v2/  the H.264 simulator stream spike (helper, bench, decode test)
```

- **npm workspaces.** The root is private and holds the shared scripts:

  | Script | What it does |
  |---|---|
  | `build` | Builds the CLI and the agent |
  | `test` | All vitest tests |
  | `typecheck` | Every tsconfig |
  | `desktop:dev` | Runs the app in development |
  | `desktop:build` | Builds the installer and the portable app |
  | `desktop:test` | Playwright |
- **`@capmac/core` is consumed as source.**
  - Its `exports` point at `.ts` files. esbuild, Vite and vitest compile it, and TypeScript resolves it.
  - It is never published: the CLI's esbuild bundle inlines it.
  - The published `capmac` package keeps the same `bin`, `dist/cli.js`, `dist/agent.mjs` and `dist/viewer.html`, and the same runtime dependencies.
- **The agent is built once and shared.** `packages/core/scripts/agent-build.mjs` produces a deterministic `agent.mjs`, stamped with core's version. The CLI and the app ship byte-identical agents, so they share one upload on the Mac (`~/.capmac/agent/<hash>/`).
  - Agent cleanup on the Mac now keeps any version used in the last 3 days. Mismatched front ends therefore never delete each other's running agent.

### Engine in a utility process

```
┌────────────── Electron main ───────────────┐      ┌──── utilityProcess: engine host ────┐
│ windows, tray, notifications, dialogs,     │      │ @capmac/core engine                  │
│ settings, protocol app://, IPC validation  │◄────►│ MacLink per Mac (one SSH connection) │
│ (zod)                                      │ port │ sessions, targets watch, screen      │
└─────▲───────────────────────────▲──────────┘      └──────────▲───────────────────────────┘
      │ ipcRenderer.invoke (typed,│ webContents.postMessage     │ MessagePort (per screen
      │ validated) + events       │ (screen port transfer)     │ stream; binary frames,
┌─────┴───────────────────────────┴──────────┐                 │ transferables)
│ renderer (sandboxed, contextIsolation)     │                 │
│ React UI ── window.capmac (contextBridge)  │                 │
│ screen worker: port ─► VideoDecoder (H.264)│◄────────────────┘
│ or createImageBitmap (JPEG) ─► Offscreen   │
└────────────────────────────────────────────┘
```

- **The engine runs in a `utilityProcess`.**
  - SSH crypto, file hashing and archive compression never block the main process, which owns window responsiveness.
  - If the engine crashes, main restarts it and the UI shows "Reconnecting to the engine…".
  - One engine serves every window and the tray.
- **Main**
  - Validates every renderer request with zod: a method allow-list plus a params schema.
  - Owns the OS integrations: folder picker, `code -g`, `shell.openPath`, notifications, tray, the theme, the accent colour.
  - Relays engine events to the renderer in batches: one message per animation frame at most.
- **Screen frames** use a `MessageChannelMain` per stream. One port goes to the engine and the other to the renderer: preload → `window.postMessage` → the screen Worker. Frames are binary `ArrayBuffer`s, never JSON: the engine copies each frame once into its port (Electron's `MessagePortMain` cannot transfer buffers), the renderer side moves them on to the worker without copying. The worker acks each frame.
  - JPEG: at most two frames in flight; under backpressure only the newest waiting frame is kept.
  - H.264: every frame goes on in order, since a delta frame is useless without the ones before it. When 30 frames wait unacknowledged, the engine drops up to the next keyframe and asks for one.
  - Input events travel back on the same port, and the engine validates them before forwarding them to the agent.
  - When the Mac connection drops, the stream reports `reconnecting` (the last frame stays, dimmed) and resumes by itself, from a keyframe.
- **Security**
  - `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
  - The renderer is served from a privileged `app://` scheme via `protocol.handle`, never `file://`. Strict CSP:

    ```
    default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
    img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none';
    base-uri 'none'; frame-ancestors 'none'
    ```
  - `setWindowOpenHandler(() => ({action: 'deny'}))`. `will-navigate` and `will-redirect` are blocked unless the URL is the app's own (scheme, host and port compared: Node reports `app:`, `file:` and `data:` URLs all with the origin "null", so comparing origins would let them through). IPC from any other page is refused. Permission requests are denied, except clipboard-sanitized-write. `app.requestSingleInstanceLock()`; a second launch focuses the existing window and opens any folder passed in.
  - Passwords pass through memory only, renderer → main → engine → the agent's stdin, and are never logged or stored. Nothing secret is persisted; if that changes, it goes through `safeStorage`.
- **Packaging**
  - Main, preload and engine are bundled by esbuild with all their JavaScript dependencies, so the app ships no `node_modules`: `app.asar` holds `out/` and `package.json` only. The bundles are CommonJS (`.cjs`) because bundled CommonJS packages such as ssh2 expect `require` and `__dirname`. ssh2's optional native add-ons (`cpu-features`, `sshcrypto`) are left out; it falls back to pure JS. That also means no native rebuild.
  - Electron fuses lock the shipped binary: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` are ignored, the asar integrity is checked, and app code loads only from `app.asar`.
  - `agent.mjs` and the sample app ship in `resources/` (`extraResources`).
  - electron-builder targets: NSIS (assisted, per-user) and portable, each for x64 and arm64. The version comes from `apps/desktop/package.json`.

---

## 4. Engine API

The engine is UI-agnostic:

- It **reports** through typed events.
- It **asks** through a `Prompter` (passwords, confirmations, choices).
- It never touches stdout or the DOM.

The CLI renders the events to the terminal and answers prompts with readline. The app renders them with React and answers prompts with dialogs.

### Context

```ts
export interface EngineContext {
  emit(event: EngineEvent): void;   // reporter
  prompter: Prompter;
  verbose: boolean;
  signal?: AbortSignal;
}

export interface Prompter {
  readonly interactive: boolean;                       // false in CI → never prompt, fail with a hint
  password(req: { purpose: 'pair' | 'keychain' | 'sudo'; message: string; mac?: string }): Promise<string>;
  confirm(req: { message: string; detail?: string; defaultYes?: boolean; danger?: boolean }): Promise<boolean>;
  choose<T>(req: { message: string; items: Array<{ label: string; value: T; hint?: string }> }): Promise<T>;
  text(req: { message: string; defaultValue?: string; placeholder?: string }): Promise<string>;
}
```

### Events

```ts
export type Phase = 'web' | 'devserver' | 'sync' | 'deps' | 'cap' | 'build' | 'boot' | 'install' | 'launch'
                  | 'archive' | 'export' | 'download' | 'other';

export type EngineEvent =
  | { type: 'step'; id: string; title: string; phase: Phase }
  | { type: 'step-progress'; id: string; text: string; fraction?: number }
  | { type: 'step-end'; id: string; status: 'ok' | 'failed' | 'skipped' | 'cancelled'; ms: number; detail?: string }
  | { type: 'phase-skipped'; phase: Phase; reason: string }   // a phase that did not need to run
  | { type: 'diagnostic'; diagnostic: LocalDiagnostic }        // file mapped to the Windows path
  | { type: 'app-log'; entry: AppLogEntry }                    // classified: source, level, text, ts
  | { type: 'log'; level: 'debug' | 'info' | 'success' | 'warn' | 'error'; message: string; hint?: string; details?: string[] }
  | { type: 'tool-output'; stream: 'stdout' | 'stderr'; text: string }   // verbose only
  | { type: 'devserver-output'; text: string }
  | { type: 'target'; target: Target }
  | { type: 'devserver'; url: string; external: boolean }
  | { type: 'tunnel'; state: 'up' | 'down'; liveUrl?: string; via?: string }
  | { type: 'hmr'; state: 'connected' | 'disconnected' | 'update'; at: number }
  | { type: 'app'; state: 'launching' | 'running' | 'exited' | 'stopped'; name?: string; exitCode?: number | null }
  | { type: 'build-reused'; reason: 'native-unchanged' | 'web-patched' }
  | { type: 'native-change'; paths: string[]; kinds: ChangeKind[] }
  | { type: 'connection'; mac: string; state: 'connecting' | 'connected' | 'lost' | 'reconnecting' | 'restored' | 'offline'; attempt?: number; error?: string; latencyMs?: number }
  | { type: 'session'; state: 'starting' | 'building' | 'running' | 'idle' | 'stopping' | 'stopped' | 'failed'; mode: 'run' | 'live' | 'ipa'; error?: ErrorInfo }
  | { type: 'check'; check: Check }                            // doctor, streamed
  | { type: 'targets'; targets: TargetsResult };               // watch-targets updates
```

Agent events are translated by `AgentEventTranslator`:

- Agent steps become steps with a `phase`.
- `progress` goes to the innermost open step.
- Diagnostic paths and text pass through `PathMapper`.
- App lines pass through `AppLogClassifier`, which groups multi-line console messages.

Presentation filters belong to the front ends: hiding bridge traffic, hiding dependency warnings, verbose tool output.

### Building blocks

```ts
class MacLink {                                          // one per Mac; owns reconnects
  constructor(macName: string | undefined, ctx: EngineContext, opts?: { autoReconnect?: boolean });
  readonly state: ConnectionState;
  session(): Promise<MacSession>;                       // connects on demand
  onChange(cb): () => void;                             // connected / lost / restored
  close(): void;
}

class Pipeline {                                         // the shared steps behind run/live/build
  sync(includeWebDir, signal): Promise<SyncSummary>;
  prepare(liveUrl, { full, signal }): Promise<PrepareResult>;
  chooseTarget(query): Promise<Target>;
  build(target, options, signal): Promise<BuildResult>;   // unlocks the keychain via prompter on demand
  deploy(target, build, { attach, signal }): Promise<DeployResult>;
}

class RunSession  { start(): Promise<void>; stop(): Promise<void>; }      // web build → … → launch, attach logs
class LiveSession { start(); rebuild({ clean? }); relaunch(); stop(); }   // dev server, tunnel, watcher, reconnect
class ScreenStream {                                     // smooth (H.264) with the compatible stream (JPEG) as fallback
  constructor(link, udid, { prefer: 'smooth' | 'compatible', fps?, quality?, maxSize? }, handlers);
  start(); input(e: InputEvent); requestKeyframe(); setVideoSize(px); retrySmooth(); stop();
}  // handlers: onVideo / onFrame, onCodec(codec, fallback), onPreparing, onClock, onInfo, onState, onEnd
function pairMac(dest, ctx, opts): Promise<HostConfig>;
function runDoctor(link, project, ctx): Promise<Check[]>;   // emits 'check' events
function applyFix(link, fixId, ctx): Promise<void>;
function exportIpa(link, project, opts, ctx): Promise<{ file: string }>;
function discoverMacs(timeoutMs?): Promise<DiscoveredMac[]>;
function inspectProject(dir): Promise<ProjectSummary>;  // + syncSize(), appIcon()
```

### Desktop RPC surface

These are the methods main forwards to the engine host, every one validated:

| Area | Methods |
|---|---|
| `macs` | `list`, `discover`, `pair`, `unpair`, `setDefault`, `connect`, `health`, `fix`, `unlockKeychain` |
| `targets` | `list`, `watch`, `unwatch`, `refresh` |
| `simulators` | `boot`, `shutdown` |
| `projects` | `inspect`, `syncSize`, `createSample`, `installDeps` |
| `sessions` | `start`, `stop`, `rebuild`, `relaunch`; `start` takes `{ projectPath, mode: 'run' \| 'live', mac?, target?, options }` |
| `builds` | `ipa` |
| `xcode` | `open` |
| `logs` | `buildLog` |
| `screen` | `stop`, `screenshot` (streams open through main's `app:screen-open`, which creates the port pair) |
| `debug` | `dropConnection` (development builds, to test reconnects) |

Prompts (passwords, host keys, confirmations) go main → renderer and come back through `app:prompt-response`, validated like everything else.

Events reach the renderer as `{ scope: { sessionId?, mac?, watchId? }, event }` envelopes, in batches.

---

## 5. Simulator streaming v2

**Goal:** 30–60 fps and under 100 ms latency over Wi-Fi, carried by the existing SSH connection. No new ports.

**Status:** shipped in CapMac Studio as *the smooth stream*, with the JPEG stream (v1, *the compatible stream*) as its automatic fallback. On the LAN: 55–61 fps, 7–16 ms (p50) from the Mac's screen to the PC's, and a median of 54 ms from a click to the app's answer on screen.

### The compatible stream (v1)

The agent polls `simctl io screenshot --type=jpeg` (160–205 ms per shot, measured on an M1 with Xcode 26.6) and downscales with `sips` (80–93 ms). That gives about 4 fps, 80–115 KB a frame, 2.5–3.6 Mbps while the screen changes, and frames that are already ~250–300 ms old when they leave the Mac. Unchanged frames are skipped. The ceiling is the screenshot round trip, not the network. It now takes input through CapMac's helper too (an input-only helper, `--video 0`), so a fallback keeps touch and typing.

### How it works

```
Mac                                                         Windows
┌─ agent op `stream` ─────────────────────────────────┐    ┌─ engine (utility process) ─────┐    ┌─ screen worker ───────────────┐
│ ensures ~/.capmac/bin/<hash>/simstream (compiled    │    │ ScreenStream: H.264 first,     │    │ VideoDecoder (WebCodecs,      │
│ with the Mac's Xcode on first use), runs it, relays │───►│ JPEG fallback with a reason;   │───►│ prefer-hardware, optimize-    │
│ its messages as binary frames, unchanged; input to  │    │ acks frames, pings for the     │    │ ForLatency) → OffscreenCanvas │
│ the helper; stall check; latency cap               │◄───│ clock; drops to the next key-  │◄───│ skips deltas when behind;     │
│                                                     │    │ frame when the renderer lags   │    │ input from the pane           │
│ simstream: SimScreen frame callbacks → framebuffer  │    └────────────────────────────────┘    └───────────────────────────────┘
│ IOSurface → VTPixelTransfer (NV12, scaled) →        │
│ VideoToolbox H.264 → stdout                         │
│ stdin: k s p q · t T c w b K → Indigo HID           │
│ (SimulatorKit SimDeviceLegacyHIDClient)             │
└─────────────────────────────────────────────────────┘
```

- **The helper** (`packages/core/src/agent/helper/simstream.m`, Objective-C).
  - It ships inside the agent bundle as text and is compiled on first use with `xcrun clang` into `~/.capmac/bin/<hash>/`; the hash covers the source, the Xcode developer directory and build, and the architecture. Compiling takes about 1.2 s.
  - A compile error is cached as `error.log`, so the next stream falls back at once instead of compiling again. The Macs health check shows it, with *Try again*. Builds unused for 14 days are removed.
  - Capture: the device's own screen (`screenType` 0). A frame is encoded as soon as a frame callback arrives, at most 60 a second, and nothing is encoded while the screen is idle. After two quiet seconds the helper checks whether CoreSimulator swapped the framebuffer without saying so, and follows it.
  - Encode: VideoToolbox H.264 High, real time, no frame reordering, 6 Mbps average, keyframes only on request. The longest side follows the pane's canvas (640–2400 px; the `s` command re-creates the encoder).
  - **A byte budget.** On incompressible content (noise, video) the hardware encoder overshoots its average several times over (38 Mbps for full-screen noise at 1400 px) and ignores `DataRateLimits` and the frame-QP limits in real-time mode. The helper keeps its own budget, 125% of the bitrate as a token bucket with half a second of burst, and encodes fewer frames when it runs out: full-screen noise streams at 12 fps and 7.5 Mbps.
  - Out: config, frame and pong messages, and JSON events (hello with the screen size and input support; status every second with the memory footprint; input errors; fatal errors with a code). In: one command per line.
  - It exits when stdin closes (the agent went away) or on SIGTERM, lifting any finger still down first.
- **The agent op `stream`** (`ops/stream.ts`) ensures the helper, starts it, relays its config and frame messages as binary frames, answers clock pings, forwards keyframe and size requests and input, and reports the screen (points, scale, input mode).
  - **Latency cap** (`VideoWindow`): the engine acknowledges frames as they arrive. When the oldest unacknowledged frame is more than 350 ms old, the agent stops sending deltas, and resumes from a fresh keyframe once the backlog has cleared.
  - **Stall check** (`StallWatch`): only while the stream is quiet, the agent compares two screenshot hashes taken a few seconds apart, backing off to 20 s. A change the helper did not see ends the op with `STREAM_STALLED`.
  - **No orphans:** the client pings every 2 s. Fifteen seconds of silence means it is gone (a dropped Wi-Fi leaves the SSH channel open on the Mac for minutes), so the op ends and the helper with it. The `screen` op does the same once its client pings.
- **The engine** (`ScreenStream`) prefers H.264 and falls back to JPEG, with a reason, when:
  - the helper cannot build or start;
  - it exits;
  - no keyframe arrives within 1.5 s of one being asked for (at start, after a reconnect, after a decoder reset);
  - or the stall check fires.

  A fallback lasts for the stream; *Try the smooth stream* clears it. Pings every 2 s also keep an NTP-style clock offset (the shortest round trip wins) for the latency readout.
- **The screen worker** configures WebCodecs' `VideoDecoder` from the config message (the codec string and `description` come from the avcC record) with `prefer-hardware` and `optimizeForLatency`. Each `VideoFrame` is drawn as soon as it is decoded and closed when the next one arrives; the newest is kept for redraws on resize. When more than three frames wait in the decoder, it skips deltas up to the next keyframe and asks for one; a decoder error resets it the same way.
- **The SPS says frames come in order.** VideoToolbox writes no VUI bitstream restriction, so a decoder has to assume frames may be reordered and holds up to a DPB's worth of them: on this PC, about 16 frames, or 270 ms at 60 fps. CapMac rewrites the SPS in the avcC record to declare `max_num_reorder_frames = 0` (`shared/h264.ts`, applied when the worker reads the config). Decoding went from about 270 ms to 0.5 ms a frame.
- **The picture's edges.** The encoder pads 642×1398 to 656×1408. Scaling down with high-quality smoothing samples past the visible edge into that green padding, so the worker draws from a source rectangle one pixel smaller.

### Input

- CapMac's helper sends Indigo HID messages through `SimulatorKit.SimDeviceLegacyHIDClient`, built the way idb (FBSimulatorControl, MIT) builds them for Xcode 26:
  - **One finger.** SimulatorKit only builds multi-touch messages, with `IndigoHIDMessageForMouseNSEvent(p1, p2, target 0x32, type, size, edge)`. The helper takes their digitizer contact and wraps it as a single-touch message. A move is another touch-down at the new point.
  - **Two fingers** use the builder's multi-touch message as it is.
  - **Buttons:** `IndigoHIDMessageForButton(source, direction, 0x33)`; home 0, lock 1, side 0xbb8, Siri 0x400002, Apple Pay 0x1f4.
  - **Keys:** `IndigoHIDMessageForKeyboardArbitrary(usage, direction)` with USB HID usages (page 7).
  - **Edge gestures** need the edge flag on every contact: a touch that starts within 2% of the bottom edge is a swipe from the home indicator (Home, the app switcher), from the top it opens Notification Centre, from the left it goes back.
- Two behaviours iOS needed help with:
  - A lifted finger keeps the speed of its last movement, however long it held still. After a drag that stopped, the helper adds a few 0.4 pt moves before lifting, so the content stops where the pointer stopped. Taps lift at once: settling them as well delayed every click by 64 ms.
  - One big move per wheel notch is mostly lost to the touch slop. A wheel scroll first moves 12 pt, then follows the wheel in steps of 24 pt, 4 ms apart, and lifts 120 ms after the last notch. 87% of the wheel distance reaches the content (with 2 ms steps, only two thirds).
- **Text:** characters a US keyboard types become key presses, with Shift where needed. Other characters, text longer than 200 characters and pastes go through `simctl pbcopy` and ⌘V; iOS accepts that without a paste prompt.
- **Xcode 27:** CoreSimulator 1155.4 and later ignore legacy Indigo input (idb moved to DTUHID). The helper and the health check detect it from CoreSimulator's version; the pane then uses AXe when it is installed, and is view only otherwise, with the reason.

### Results

Measured in the app (engine → port → worker), the Mac to this PC on the LAN, iPhone 17 simulator:

| | Smooth stream | Compatible stream |
|---|---|---|
| Frame rate | 55–61 fps for animation and scrolling; 12 fps for full-screen noise at 1400 px, held by the budget | 2–4 fps |
| Capture on the Mac → decoded on the PC | p50 7–16 ms, p95 14–44 ms (a banner animation); p50 13–18 ms, p95 23–42 ms (full-screen noise at 640 px) | ~300 ms |
| Click → the app's answer on screen | median 54 ms, 37–69 ms over 12 clicks (iOS alone takes 57–98 ms from a tap to the new frame on the Mac) | |
| Bandwidth | 0.15–0.3 Mbps scrolling, 0.24 Mbps full-screen gradient, 7.5 Mbps at most; nothing while the screen is idle | 2.5–3.6 Mbps |
| Decoding on Windows | 0.4–0.8 ms a frame (hardware) | `createImageBitmap` |
| The app with an idle screen | 1.6% of one PC core, all processes | screenshots keep coming |
| The helper's memory | flat: 11.9 MB at start, then 13.5–13.8 MB for 30 minutes of full-screen noise | |

Verified on the Mac:

- killing the helper mid-stream switches to the compatible stream within about a second, and touch keeps working through an input-only helper; *Try the smooth stream* brings H.264 back;
- dropping the SSH connection dims the last frame, then the stream resumes from a keyframe;
- no `simstream` process remains after a stop, a reconnect, a fallback or a killed client;
- tapping the sample's button logs `Counter: N`, typing logs `Note: …`, the wheel scrolls its list, Home and Lock work, and a swipe up from the bottom edge unlocks.

### Prior art

| Project | What it offers | Use |
|---|---|---|
| serve-sim (EvanBacon, Apache-2.0) | IOSurface → H.264 over WebSocket, WebCodecs client | Closest match. Its capture and encode approach can be studied and adapted (licence permits). |
| idb (Meta, MIT) | `idb video-stream --format h264`; Indigo HID on Xcode 26, DTUHID on Xcode 27 | The source of CapMac's Indigo message layout. A heavy install (Python client and companion), so not a runtime dependency. |
| baguette (tddworks, Apache-2.0) | `baguette serve`: WebSocket with MJPEG/AVCC, gesture JSON | Its notes on the Xcode 26 mouse message: the real signature has the edge in the fifth integer argument. |
| AXe | Input (tap, swipe, type, buttons) | Now the fallback for input. **Not** for streaming (`stream-video` leak, issue #72). |
| Radon IDE simulator-server | — | Closed source; not used. |

### The spike

The spike in `spikes/streaming-v2/` (`simstream.m`, `bench.ts`, `decode-test.mjs`, `tools/`) measured both pipelines at 642×1398 with the sample app running a 60 Hz animation:

| | v1: JPEG screenshots | v2: H.264 helper |
|---|---|---|
| Frame rate, a banner over 15% of the screen | 3.7 fps | 58.6 fps |
| Frame rate, the whole screen changing | 3.9 fps | 54.7 fps |
| Bandwidth | 2.5–3.6 Mbps | 0.29 Mbps (banner), 4.3 Mbps (whole screen) |
| Capture on the Mac → arrival on the PC | ~250–300 ms | p50 17.5–19 ms, p95 30–41 ms |

What it found, and what the product changed:

- **Rate control matters.** VideoToolbox's low-latency rate control dropped half the frames at 6 Mbps; standard rate control kept 55–60 fps. The product keeps standard rate control and adds its own byte budget for incompressible content.
- **Pick the device's own screen** (`screenType` 0): after a reboot, "TVOut" came first in the list.
- **One unexplained failure.** Once, before a simulator reboot, the main screen accepted the callbacks but its framebuffer never updated, while screenshots kept working. The product follows a swapped framebuffer, checks for stalls, and offers *Restart simulator*.
- **Never set the screen's power state.** `SimScreen setPowerState:` with an unexpected value turned the device's display off until a reboot.
- **The spike measured arrival, not display.** Its decode test fed a recorded stream back to back, which hid the decoder's 270 ms of buffering; the product found it, and fixed it in the SPS.

### Next

- Input on Xcode 27 through DTUHID, the path idb moved to, detected at runtime.
- The smooth stream in the CLI's browser viewer (`capmac screen`), with the same worker code.
- ~~Adaptive bitrate~~: done, see §6.
- Rotation (`SimDevice` orientation), and HEVC where both ends decode it in hardware.

---

## 6. Remote access

**Goal:** reach a paired Mac from anywhere (a café, the office, a phone's hotspot) exactly as on the local network: run, live reload, the simulator, builds. Peer to peer when the two networks allow it, through a relay when they don't. Nothing else to install, and the local network unchanged.

**Status:** shipped in the CLI (`capmac remote …`) and CapMac Studio (Macs › Remote access), with the same options and one shared config. Verified on the real Mac with a signaling server on this PC (both machines on one network, so peer to peer took a local path). A test between two real networks waits for the server on your VPS.

### How it works

```
PC (engine)                              your server (services/signal)                     Mac
ssh2 ── sock ── WebRTC data channel ════ UDP, peer to peer (hole punched) ════════ door ── TCP ── sshd :22
           └─── or the relay ─────────── wss://server/v1/pipe/<session> ────────── door
      signaling: wss://server/v1/pc/<mac key>          wss://server/v1/mac/<mac key> (always connected)
```

- **One SSH connection, as before.** ssh2 takes any byte stream as its `sock`, so the data channel (or the relay) only has to carry SSH to the Mac's sshd. The agent protocol, sync, builds, the stream, input and the live-reload reverse tunnels are unchanged.
- **The door** (`packages/core/src/door`) is a LaunchAgent, `dev.capmac.remote`, run by the Mac's Node.js 22+ while the user is logged in. The agent op `remote-install` writes it to `~/.capmac/remote`, installs node-datachannel there with the Mac's own npm, and loads it.
  - It keeps a WebSocket to the signaling server, so PCs can find the Mac on any network.
  - It lets in only the PCs in `allowed.json`, checks their signatures, and bridges each connection to `127.0.0.1:<ssh port>` and nothing else.
  - *Keep this Mac awake* runs `caffeinate -i -s` for as long as the door runs.
  - It reports itself in `status.json` for the health check, and logs to `door.log` (kept small).
  - Changing it through itself is safe. Turning remote access off, or restarting the door (keep awake, repair), while connected over the internet answers first. A detached process then stops or restarts the door a second later. The agent knows it came through the door because sshd sees that connection from 127.0.0.1.
- **The signaling server** (`services/signal`, one Node.js file or one container):
  - **signaling:** it relays offers, answers and ICE candidates;
  - **presence:** it tells a PC whether its Mac is online, and when it was last seen;
  - **the relay:** two WebSockets, one from each end, piped together;
  - **STUN:** on UDP 3478;
  - optional **TURN credentials** for coturn.

  It keeps no state on disk, and limits sockets and attempts per address and per key.
- **Peer to peer first, then the relay.** WebRTC gets 8 seconds (less when ICE fails); then the relay, unless relaying is off. CapMac relays through its own server, not TURN, because libjuice (node-datachannel's ICE) relays over UDP only: a WebSocket over HTTPS gets through networks that only allow the web.
- **Which way:**
  - *Automatic* gives the local network a 500 ms head start, then also tries the internet; the first SSH session to be ready wins.
  - *Local network only* and *Over the internet* do what they say.
  - The CLI's `--route` (or `CAPMAC_ROUTE`) overrides it for one command.

  A host key mismatch on the local network, while the internet route works, is another device at that address on whatever network this PC is on: it is not reported.
- **The local network got faster too.** The address that worked last time is tried first while Windows resolves the `.local` name: SSH is ready in 0.2 s instead of 2.9 s.
- **Adaptive bitrate** (`agent/helper/bitrate.ts`): the helper takes a new bitrate on the fly (`r <bps>`). Once a second the agent looks at the frame window:
  - down 30% as soon as frames lag past 220 ms or are dropped;
  - up 15% after three calm seconds of real traffic.

  The starting point and ceiling depend on the route: 6 Mbps on the local network, 4 (up to 6) peer to peer, 2.5 (up to 4) through the relay.

### Security

- **SSH stays the boundary:** the Mac's pinned host key and CapMac's own key protect the connection end to end. The server and the relay only ever see encrypted bytes.
- **Identities:** every PC (`%USERPROFILE%\.capmac\remote_ed25519`) and every door (`~/.capmac/remote/door_ed25519`) has an Ed25519 key. The PC's key goes on the door's allowlist, and the door's key is pinned on the PC, both at pairing over the local network.
- **Signatures** (`shared/remote.ts` says exactly what is signed; each purpose has its own prefix):
  - the hello on every socket, against the server's challenge;
  - each offer and answer, binding the DTLS fingerprints to the session and both keys, so the server cannot sit in the middle of a peer-to-peer connection;
  - each relay request, for one use, within 10 minutes of the Mac's clock.
- **The door refuses everyone else** before a single byte reaches sshd. That matters: macOS's sshd accepts passwords.

### The options, in the CLI and CapMac Studio

| Option | CLI | CapMac Studio |
|---|---|---|
| Reach this Mac from anywhere (off by default) | `capmac remote on` / `off [--local]`, `capmac pair --remote` | Macs › Remote access; the pairing screen |
| Connection: Automatic, Local network only, Over the internet | `capmac remote set --route`; `--route` on any command, for one time | Macs › Remote access › Connection; the command palette |
| Relay: when needed, never, always | `capmac remote set --relay` | Macs › Remote access › Relay |
| Keep this Mac awake | `capmac remote set --keep-awake on\|off` | Macs › Remote access; the command palette |
| The PCs that can reach the Mac | `capmac remote pcs`, `capmac remote revoke` | Macs › Remote access › PCs |
| The signaling server | `capmac remote server`, `CAPMAC_SIGNAL_URL`, `capmac remote set --signal-url` (moves a Mac) | Settings › Remote access; *Move to …* on a Mac |
| Status and tests | `capmac remote status [--test]`, `capmac remote test`, `capmac doctor` | the Mac's card and chip, the toolbar, the simulator footer, *Test over the internet*, Check health |

### Results

Measured on 2026-10-13, this PC to the M1 Pro over home Wi-Fi, with the signaling server on this PC:

| | Local network | Over the internet, peer to peer | Over the internet, relay |
|---|---|---|---|
| SSH ready | 0.2 s (was 2.9 s) | 0.4–0.5 s | 0.3–0.4 s |
| Echo through SSH (p50) | 7–12 ms | 9 ms | 16 ms |
| Upload / download | 88 / 57 Mbps | 90 / 63 Mbps | 58 / 47 Mbps |
| Simulator stream | 55–61 fps | 64 fps, p50 15–21 ms, 4 → 6 Mbps | |

Other measurements:

- **Turning remote access on:** about 3 s the first time (npm installs node-datachannel on the Mac), 1 s after that.
- **A full `capmac run --route internet`** worked end to end on the sample, console included.

On one network, "peer to peer" takes a local path, and the relay here went through this PC: a real internet path will be slower.

### The transport (the spike)

`spikes/internet-access/` compared the candidates with CapMac's real SSH session:

- **WebRTC through node-datachannel:** 130 / 83 Mbps, and prebuilt for every platform CapMac targets.
- **iroh 1.0's Node binding:** 31–39 Mbps for a full CPU core, with no Intel Mac build.
- **iroh's native dumbpipe:** fast, but it would mean shipping and signing a Rust helper.
- **PeerJS:** made for browsers and no longer released.

WebRTC with our own server won: everything stays TypeScript, and the user's own server does signaling, the relay and STUN.

### Next

- The test between two real networks (a phone's hotspot) once the server is deployed, and coturn if some network needs TURN over UDP.
- If a big sync holds up the stream over the internet (SSH sends everything in order), give the screen its own SSH connection over a second data channel: SCTP streams don't block each other.
- Tailscale: list a tailnet's Macs when pairing.

---

## 7. Electron apps on the Mac

**Goal:** an Electron app (plain Electron, electron-vite, Electron Forge, or Capacitor's Electron platform) builds, runs, live-reloads and shows on the paired Mac exactly like an iOS app on a simulator, from the CLI and CapMac Studio, without disturbing whoever is using the Mac.

**Status:** shipped in the CLI (`capmac run`, `dev`, `screen --electron`, `screenshot --electron`, `targets --electron`) and Studio (the *Mac desktop (Electron)* target, the window pane, the Electron sample). Verified on the real Mac (macOS 26.6, Electron 44) with the two samples and an electron-vite app.

### How it works

- **The target** is the Mac's desktop (`mac-desktop`). An Electron project always runs there; a Capacitor project does with `--electron`, `--target mac`, or when Electron is its only platform.
- **Prepare** (`electron-prepare`): the agent installs the app's dependencies on the Mac, fetches Electron's macOS build when Windows installed only its own, copies the web app into Capacitor's platform, and builds (`npm run build`, never a packaging script).
- **CapMac's module in the app** (`src/electron-hook/hook.ts`). The agent launches the app, or its dev command, with `NODE_OPTIONS=--require <module>`. The module turns itself on only in Electron's main process, and only when the agent asked for it.
  - **Output:** it marks the main process's lines, and reports windows and every page's console as marked lines on stdout. The CLI and Studio tell main, page, Chromium and dev-tool output apart.
  - **The windows:** a Unix socket in `~/.capmac/run` serves frames from the app's own compositor (`beginFrameSubscription`, JPEG), input (`sendInputEvent`), screenshots (`capturePage`) and reloads. None of this needs Screen Recording or Accessibility permission, which SSH sessions can't get anyway.
  - **Input:** Ctrl on the PC is ⌘. Menu shortcuts run the menu item, the way macOS does, matched by the letter the PC's layout types. Text arrives as characters in order. Copying in the app sends the text to the PC's clipboard.
- **Capacitor live reload:** Vite runs on the PC behind an SSH reverse tunnel. The module sends the app's `capacitor-electron://` loads to the dev server, drops the page's Content-Security-Policy for that origin only, and lets the dev server's own reloads through the template's navigation guard.

### Live reload, by flavor

| Flavor | Live reload | A main-process change |
|---|---|---|
| Plain Electron | CapMac syncs and reloads the window | restart, when the main process loaded the file (CapMac asks the app) |
| electron-vite | `electron-vite dev --watch` on the Mac | rebuilt and restarted by electron-vite |
| Electron Forge | `electron-forge start` on the Mac | `rs`, typed into Forge |
| Capacitor Electron | the dev server on the PC, HMR through the tunnel | the platform is rebuilt and restarted |

`capmac.json`'s `electron` section (`dir`, `build`, `start`, `dev`) overrides any of it.

### The Mac's focus

Someone may be working on the Mac, so the app must not take their keyboard or cover their work. Without CapMac, a new `BrowserWindow` activates the app (`activateIgnoringOtherApps`), and so do `show()`, `focus()`, `webContents.focus()` and `app.focus()`. While the app is not the active app, the module changes that:

- **Windows open behind every other window**, without activating the app (`showInactive()` and `blur()`). `show()` does the same, and a window still streams and takes input from there.
- **Focus requests only give the page focus** (`focusOnWebView()`): it gets a caret and focus events, but not the Mac's keyboard. CapMac's view follows the window the app brought forward, and `isFocused()` and `getFocusedWindow()` report it.
- **DevTools and full screen wait** until someone switches to the app; the CLI and Studio say so once. Links open in the Mac's browser without bringing it forward.
- **It installs before the app opens anything:** it watches Node.js's loader for the app's first `require('electron')`, and redirects an ES module app's `import … from 'electron'` with `module.registerHooks`. Either way the app gets window classes that open windows the guarded way.
- **Someone at the Mac comes first.** Once the app is active (a click on it or its Dock icon), or just after a click on its menu bar icon or a global shortcut, the app behaves as usual. A sheet stays on its window as always.
- **Restarts:** the module remembers whether the app was in front (`<socket>.front`). A live-reload restart comes back in front only if someone was using the app; a new launch never does.

Elsewhere: `--show-simulator` opens Simulator in the background (`open -g`). When the engine needs an answer (a password, say), Studio waits for the user instead of jumping to the front: its taskbar button flashes and a notification says so.

### Results

Measured on 2026-10-15 on the paired M1 (macOS 26.6.1), over home Wi-Fi. Someone was working on the Mac during the plain and Capacitor runs, and its front app (`lsappinfo front`, sampled every 100 ms) never changed; the Mac was locked by the electron-vite run:

| | Time |
|---|---|
| `capmac run` of the plain sample, up to date | running in 1.6 s |
| Plain Electron: a page edit → the new code runs | 0.4 s |
| Plain Electron: a main-process edit → the new main runs | 0.9 s |
| Capacitor Electron: a web edit → HMR in the app | 0.18 s |
| electron-vite: a renderer edit / a main-process edit | 0.6 s / 0.56 s |

Input through the stream (clicks, typing, paste, ⌘A, a menu shortcut, the wheel) works on a window behind other apps and without focus. Unit tests drive the guard with a fake Electron for the parts that would need someone to switch apps on the Mac.

### Next

- Native dialogs (`dialog.showMessageBox`, file pickers) are not in the window's frames: show them in the CLI and Studio, and answer them from there.
- Open links the app opens on the PC instead of the Mac.
