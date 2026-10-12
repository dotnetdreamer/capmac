# capmac Studio — design

capmac Studio is the Windows desktop app for capmac. It does what the CLI does: pair with a Mac, then build, run, live-reload and see a Capacitor iOS app on it. It adds the views a terminal can't give you: a live simulator, a build timeline, clickable problems, and a console you can filter. It is built to grow into a full remote iOS Simulator for Windows.

This document covers:

1. Product: principles, information architecture, the screens and their states.
2. Visual language: tokens, type, spacing, motion, and the component inventory.
3. Architecture: the engine, the CLI and Electron.
4. The engine API.
5. Simulator streaming v2: the plan, the spike and the recommendation.

---

## 1. Product

### Principles

- **Calm by default.** Most of the time nothing is happening. The idle UI is quiet: no spinners, no polling, near-zero CPU. Motion and colour only show up when something changes state.
- **One loop, one click.** The core loop is: open project → **Live** → the app appears → edit in VS Code → it updates. Everything else supports that loop, and nothing gets in its way.
- **Every state is designed.** Loading, empty, offline, reconnecting, failed and cancelled all have their own state. Every error says what happened and how to fix it, often with a button that does the fix. Raw stack traces never reach the UI. Engine errors carry `message`, `hint` and `details`; anything unexpected becomes "Something went wrong in capmac", with a "Copy details" button.
- **Native to Windows 11.** The app uses a Mica backdrop, Segoe UI Variable, the user's accent colour and the system caption buttons with snap layouts. Focus rectangles follow Fluent. The tray icon and toast notifications work as Windows users expect.
- **Keyboard first.** Every action is reachable from the command palette (Ctrl+K) and most have a shortcut. Full screen-reader support.
- **The terminal stays first-class.** The CLI and the app share one engine, so they can't drift apart, and the CLI keeps working on its own.

### Name

The working name **capmac Studio** is clear and continuous with the CLI, and the code uses it. Alternatives, if you want one:

- **Ferry**: it carries your app across to the Mac.
- **capmac Desktop**: plain, like GitHub Desktop.

"Studio" slightly suggests an editor, which this isn't.

### Information architecture

```
capmac Studio
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
│ ◆ capmac Studio › Hello capmac       [ 🔍 Search or run a command   Ctrl+K ]   │ ─  ▢  ✕ │
└──────────────────────────────────────────────────────────────────────────────┴──────────┘
```

The whole bar is a drag region except the controls. The caption buttons come from `titleBarOverlay`, so their colours follow the theme and Windows 11 snap layouts work. The search box opens the command palette.

#### First run

The flow is a centred column, 520 px max, on Mica. A thin step indicator sits at the top, and each step ends with a primary action on the right.

1. **Welcome.** Headline: "Build and run your iOS app from Windows". The illustration shows a PC linked to a Mac with an iPhone. "Get started ▸". If the CLI already paired a Mac, first run is skipped.
2. **Prepare your Mac.** Two cards, each with a short explanation:
   - "Turn on Remote Login": System Settings › General › Sharing.
   - "Stay logged in": simulators need a desktop session.

   A note warns that Windows may ask to let capmac Studio find devices on the network: allow it on private networks. This note comes before the first scan, which binds UDP 5353. "Find my Mac ▸".
3. **Find your Mac.** A radar-style scanning indicator, then a list of discovered Macs with name, host and IP. "Enter an address instead" reveals a text field. Empty state: "No Macs found" with the likely causes (Remote Login off, different network or VPN, the firewall prompt was declined), plus "Scan again" and manual entry.
4. **Sign in.** The Mac's name, a user name field (with a hint: "the short name from `whoami`") and a password field: "used once to install capmac's key, never stored". On the first connection, a dialog shows the host-key fingerprint: "Trust this Mac?". Progress runs as a checklist:
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
6. **You're set.** The success moment: "Run the sample app ▸". It copies the bundled sample to `Documents\capmac Studio\Hello capmac`, opens its workspace and starts Run. Under 2 minutes from install to an app on the simulator. A secondary action: "Open my own project".

#### Home

```
Projects                                                    [▸ Add project  Ctrl+O]
┌───────────────────────────┐ ┌───────────────────────────┐ ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│ [icon] Hello capmac   ● Live│ │ [icon] Shop               │   Drop a Capacitor app
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
┌ [icon] Hello capmac   [IK's M1 ▾] [● iPhone 17 · iOS 26.5 ▾]     [▸ Run] [⚡ Live] [■] │ [Build IPA] [Xcode] ⋯ ┐
├──────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⚡ Live  http://localhost:5173 ⟶ tunnel ⟶ IK's M1   ● HMR connected · updated 12:04:31   [↻ Rebuild] │
├───────────────────────┬──────────────────────────────────────────────────────────────────────────────┤
│                       │ Timeline                                               Run #4 · 6.2 s         │
│   ╭───────────────╮   │ ✓ Sync 0.4s  ✓ Deps (unchanged)  ✓ cap copy 0.9s  ○ Xcode (native unchanged) │
│   │               │   │ ✓ Boot (running)  ✓ Install 1.1s  ✓ Launch 1.6s                               │
│   │   simulator   │   ├──────────────────────────────────────────────────────────────────────────────┤
│   │    canvas     │   │ [Console] [Problems 2]   JS Capacitor Native Bridge │ Level ▾ │ 🔍 search   ⏸ ⋯ │
│   │               │   │ 12:04:31.204  JS   Hello from capmac                                         │
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
  - Click, or press Enter, to open it in VS Code (`code -g file:line:col`), or in the default app if VS Code isn't installed.
  - Copy (one item, or all as `file:line:col: error: …`), and "Show full build log", which downloads the Mac-side log into a read-only viewer.
  - Warnings from dependencies (Pods, Swift packages, node_modules) are collapsed under "37 warnings from dependencies".
- **Console**: virtualized, 200k-line ring buffer.
  - Source chips: JS, Capacitor, Native, Bridge, Dev server.
  - Level menu: Errors, Warnings, Info, Debug.
  - Search with highlighted matches, a match count and F3/Shift+F3 navigation.
  - Auto-scroll pauses when you scroll up. "↓ 23 new lines" jumps back. ⏸ freezes the view.
  - Rows: timestamp, source badge, level icon, message.
    - Errors and warnings get a tinted gutter.
    - JSON in `console.log` becomes an expandable tree: arrow keys / Enter to expand, Copy value.
  - Copy (selection or all visible lines) and Export (.log).
  - Multi-line console messages are grouped into one row.

#### Simulator pane (v1)

- Frames from the agent's `screen` op go straight to a Web Worker over a transferable MessagePort. The worker decodes the JPEG with `createImageBitmap` and draws on an OffscreenCanvas. The main thread never touches pixels.
- The device frame is drawn in CSS, as a neutral rounded bezel, and can be turned off.
- **Input, when AXe is installed on the Mac:**
  - click = tap (with a ripple);
  - drag = swipe;
  - a long press is held;
  - the wheel scrolls;
  - typing goes to the simulator while the screen has focus;
  - Home and Lock buttons.
- **Without AXe**, an InfoBar: "View only. Install AXe on the Mac for touch and typing". Its "Install…" button asks for confirmation and then runs `brew install`.
- Footer:
  - Home, Lock, Type text, Screenshot (full resolution from `simctl io screenshot`; Save… / Copy);
  - live fps;
  - the stream source.
- **States**:
  - **No simulator selected:** "Pick a simulator".
  - **Shut down:** "Boot iPhone 17".
  - **Booting:** a spinner with the boot progress.
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
| About | App, Electron, Chromium, Node and agent versions; the capmac config folder; licences. |

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
  - Menu: Run «last project», Live «last project», Stop, Open capmac Studio, Quit.
  - The icon shows a dot while a session runs.
  - Closing the window during a session keeps the app in the tray (a one-time toast says so). Otherwise closing quits.
- **Notifications**: when a run finishes or fails while the window is in the background ("Hello capmac is running on iPhone 17 · 6.2 s" / "Build failed: 2 errors in AppDelegate.swift"). Clicking one focuses that workspace.

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

Icons are Fluent System Icons, regular and filled, 16 and 20 px (MIT). Only the icons in use are extracted into `src/renderer/ui/icons.tsx`, because the full package is 170 MB.

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
  desktop/   capmac Studio (Electron 44, React 19, Vite 8)
bin/capmac.js    dev shim → packages/cli (so `node bin/capmac.js` keeps working)
test/unit/       the CLI/engine/agent tests (vitest), plus engine tests
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
│ screen worker: port ─► createImageBitmap ─►│◄────────────────┘
│ OffscreenCanvas (v2: WebCodecs)            │
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
- **Screen frames** use a `MessageChannelMain` per stream. One port goes to the engine and the other to the renderer: preload → `window.postMessage` → the screen Worker. Frames are `ArrayBuffer`s moved with transfer lists, never JSON. Input events travel back on the same port, and the engine validates them before forwarding them to the agent.
- **Security**
  - `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
  - The renderer is served from a privileged `app://` scheme via `protocol.handle`, never `file://`. Strict CSP:

    ```
    default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
    img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none';
    base-uri 'none'; frame-ancestors 'none'
    ```
  - `setWindowOpenHandler(() => ({action: 'deny'}))`. `will-navigate` is blocked. Permission requests are denied, except clipboard-sanitized-write. `app.requestSingleInstanceLock()`; a second launch focuses the existing window and opens any folder passed in.
  - Passwords pass through memory only, renderer → main → engine → the agent's stdin, and are never logged or stored. Nothing secret is persisted; if that changes, it goes through `safeStorage`.
- **Packaging**
  - Main, preload and engine are bundled by esbuild with all their JavaScript dependencies, so the app ships no `node_modules`. ssh2's optional native add-ons (`cpu-features`, `sshcrypto`) are left out; it falls back to pure JS. That also means no native rebuild.
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
class ScreenStream { start(); input(e: InputEvent); screenshot(): Promise<Buffer>; stop(); }  // frames via callback
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
| `targets` | `list`, `watch`, `unwatch` |
| `simulators` | `boot`, `shutdown` |
| `projects` | `inspect`, `syncSize` |
| `sessions` | `start`, `stop`, `rebuild`, `relaunch`; `start` takes `{ projectPath, mode: 'run' \| 'live', mac?, targetUdid?, options }` |
| `builds` | `ipa` |
| `xcode` | `open` |
| `logs` | `buildLog` |
| `screen` | `start` (and the port arrives), `stop`, `screenshot` |
| `tools` | `install` |
| prompts | `prompt.respond` |

Events reach the renderer as `{ scope: { sessionId?, mac?, watchId? }, event }` envelopes, in batches.

---

## 5. Simulator streaming v2

**Goal:** 30–60 fps and under 100 ms latency over Wi-Fi, carried by the existing SSH connection. No new ports.

### Today (v1)

The agent polls `simctl io screenshot --type=jpeg` (≈130 ms per shot) and downscales with `sips` (≈60 ms). That gives about 5 fps, about 55 KB a frame, and 200–400 ms latency. Unchanged frames are skipped. The ceiling is the screenshot round trip, not the network.

### Design

```
Mac                                                        Windows
┌────────────────────────── agent op `stream` ──────────┐  ┌───────── engine ─────────┐  ┌──── renderer worker ─────┐
│ capmac-simstream (Swift, compiled on first use with   │  │ relays binary frames to  │  │ VideoDecoder (WebCodecs, │
│ the Xcode toolchain into ~/.capmac/bin/<hash>/)       │  │ the screen MessagePort;  │  │ prefer-hardware,         │
│  • CoreSimulator: SimDevice → framebuffer IOSurface   │──┤ drops to the next IDR    ├──┤ optimizeForLatency)      │
│    (damage callbacks: 0 fps when the screen is idle)  │  │ under backpressure and   │  │ → VideoFrame → Offscreen │
│  • VideoToolbox H.264 (HEVC optional), real-time,     │  │ asks for a keyframe      │  │   Canvas, frame.close()  │
│    no B-frames, keyframes on demand, CBR-ish 2–6 Mbps │  └──────────────────────────┘  └──────────────────────────┘
│  • stdin: input (Indigo HID / DTUHID), keyframe req   │
└───────────────────────────────────────────────────────┘
```

- **Capture.**
  - Use the simulator's framebuffer `IOSurface` through CoreSimulator / SimulatorKit, as idb (`FBSimulatorVideoStream`) and serve-sim do.
  - No screen-recording permission is needed, and capture works with the Simulator window hidden.
  - Frames are produced only on damage, so an idle simulator costs ~0 bandwidth.
- **Encode.**
  - `VTCompressionSession` (hardware), H.264 High@4.1, with `RealTime`, `AllowFrameReordering = false` and `MaxKeyFrameInterval = ∞`.
  - The keyframe is forced on request (stream start, decoder error, drop recovery).
  - The bitrate is adaptive. Resolution defaults to the device's point size × 2, which keeps text crisp at 100–200 % scaling.
- **Transport.**
  - Length-prefixed frames carry a header: keyframe flag, capture timestamp (mach → µs) and sequence number.
  - The agent relays them as `encodeBinary` frames over the same SSH channel, with no transcoding.
  - Backpressure: when the channel write buffer is full, the agent drops frames until the next keyframe and asks for one.
- **Decode.** WebCodecs `VideoDecoder` in the screen worker. On error, reset and request a keyframe. MJPEG (v1) stays as the fallback when the helper can't build or the OS is unsupported.
- **Input.**
  - Touch (one and two fingers: pinch and rotate as with Simulator's Option-drag) and hardware buttons go through the same helper.
  - iOS 26 uses Indigo HID messages: the 9-argument mouse event, per baguette's notes. Xcode 27 removed Indigo, so its path is DTUHID, the path idb moved to.
  - Coordinates are normalised to [0, 1] and mapped to points in the helper.
  - Hardware keyboard: HID usages with modifiers.
  - Rotation via `SimDevice` orientation.
- **Extras via `simctl`** (no helper needed):

  | Feature | How |
  |---|---|
  | Clipboard sync | `pbcopy` / `pbpaste`, both ways on focus change |
  | Drag and drop media | `addmedia` (upload, then add) |
  | Deep links | `openurl` |
  | Push notifications | `push` (APNs JSON editor) |
  | Location | `location set` / `location run` |
  | Appearance | `ui appearance` |
  | Clean status bar | `status_bar override` (9:41, full battery) |
  | Privacy permissions | `privacy grant` / `revoke` / `reset` |
  | Screen recording | `io recordVideo`, downloaded as `.mp4` |

### Prior art

| Project | What it offers | Use |
|---|---|---|
| serve-sim (EvanBacon, Apache-2.0) | IOSurface → H.264 over WebSocket, WebCodecs client | Closest match. Its capture and encode approach can be studied and adapted (licence permits). |
| idb (Meta, MIT) | `idb video-stream --format h264`; DTUHID input on Xcode 27 | Proven private-API paths. A heavy install (Python client and companion), so not a runtime dependency. |
| baguette (tddworks) | `baguette serve`: WebSocket with MJPEG/AVCC, gesture JSON | Notes on the iOS 26 Indigo 9-argument message and Xcode 27 Device Hub input shadowing. |
| AXe | Input (tap, swipe, type, buttons) | Fine for v1 input. **Not** for streaming (`stream-video` leak, issue #72). |
| Radon IDE simulator-server | — | Closed source; not used. |

### Spike results

[filled in by the spike: measured fps, latency and bandwidth per approach, and the recommendation]
