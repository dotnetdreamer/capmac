# The CapMac guide

The details behind the [README](../README.md): every framework, command, setting and fix

- [Set up your Mac](#set-up-your-mac)
- [CapMac Studio](#capmac-studio)
- [CapMac for VS Code](#capmac-for-vs-code)
- [Your Capacitor and Ionic commands](#your-capacitor-and-ionic-commands)
- [Commands](#commands)
- [Run on an iPhone](#run-on-an-iphone)
- [Build without a Mac](#build-without-a-mac)
- [Flutter apps](#flutter-apps)
- [React Native apps](#react-native-apps)
- [Electron apps](#electron-apps)
- [One folder, several apps](#one-folder-several-apps)
- [Configuration](#configuration)
- [Your Mac and your code](#your-mac-and-your-code)
- [Away from the Mac's network](#away-from-the-macs-network)
- [AI coding agents](#ai-coding-agents)
- [Troubleshooting](#troubleshooting)
- [Building and releasing CapMac](#building-and-releasing-capmac)

## Set up your Mac

On the Mac, install Xcode, open it once and install an iOS simulator runtime.
In System Settings, open General, then Sharing, and turn on **Remote Login**.
Keep the paired user logged in to the Mac's desktop, because simulators run there

On Windows, install Node.js 20.10 or newer and your app's dependencies, then pair the Mac and run your app

```powershell
npm install -g capmac
capmac pair
cd my-app
capmac doctor
capmac run
```

`capmac pair` finds Macs on your network, or takes an address such as `capmac pair user@mac.local`.
It asks you to trust the Mac's host key and uses your password once to install a dedicated SSH key. It doesn't store the password.
Use `--identity <file>` for an SSH key you already have, or `--agent` for the Windows OpenSSH agent

If Node.js is missing or too old on the Mac, pairing offers a private copy in `~/.capmac/runtime`.
CocoaPods is needed on the Mac only for projects that use it

Run app commands in your app's folder.
A Capacitor app with no iOS project yet needs `npx cap add ios` first

For live reload with the simulator in your browser:

```powershell
capmac dev --screen
```

Your dev server runs on Windows, and the app on the Mac reaches it through the SSH connection.
Web edits use the server's live reload, native edits start a rebuild, and the session reconnects if the connection drops.
Use `capmac dev --url http://localhost:5173` with a server you already started

## CapMac Studio

Pair a Mac or pick **This PC (no Mac)**, add your project and press **Live** (F5) or **Run** (Ctrl+F5).
**Try a sample** on the home screen makes a small Capacitor, Flutter, React Native or Electron app to start with

For a Capacitor app, the arrow next to **Run** offers two more ways to run.
**Run without building** uses the web files you already built, like `npx cap run ios`.
**Sync** runs `cap sync` on the Mac without building or launching the app

The workspace shows the build timeline, errors that open at the line in your editor, a console with search, source and level filters and expandable JSON, and the simulator.
The console stays fast with hundreds of thousands of lines.
Select text across any number of lines, or press Ctrl+A, then copy it with Ctrl+C or a right-click.
The arrow at the bottom right takes you back to the latest line.
Click, drag, scroll and type into the simulator, or use its Home, Lock and screenshot buttons.
Pick a real iPhone as the target to see [its screen](#see-a-real-iphones-screen) in the same place

The screen comes as H.264 video, with screenshots as a fallback.
If touch or typing doesn't reach the simulator, `capmac doctor --fix` can install AXe on the Mac

## CapMac for VS Code

The same engine as a VS Code extension, for the folder you have open. There's no project to add.
CapMac finds the apps in the workspace (Capacitor, Flutter, React Native, Electron), and **⚡ Live** or **▶ Run** starts the one you work on

- Every run is a VS Code debug session, with Stop, Restart and Hot Reload on the debug toolbar and the app's console in the Debug Console
- Pick *Live: your app* in Run and Debug once, and F5 starts it
- The simulator's screen, an iPhone's, or a Mac app's window streams into a tab beside your code, with touch, typing and screenshots
- Xcode, Swift, Dart, TypeScript and Vite errors land in **Problems**
- The **Run** view shows each build step, and the **Devices** view lists your Macs, simulators, iPhones, health checks and this PC
- Building on this PC with no Mac, pairing, remote access and the keychain all work from VS Code
- AI agents in VS Code get tools to run the app, read its console and look at its screen
- CapMac adds its [skill](#ai-coding-agents) to each project with an app, for the coding agents it finds

Install the `.vsix` from [GitHub Releases](https://github.com/dotnetdreamer/capmac/releases/latest) with `code --install-extension capmac-vscode-<version>.vsix`.
There's more in [apps/vscode/README.md](../apps/vscode/README.md) and the [design notes](vscode-extension.md)

## Your Capacitor and Ionic commands

Once CapMac is installed, your usual Capacitor and Ionic commands run on the Mac

```powershell
npx cap run ios
ionic capacitor run ios -l
```

| Command | What happens on the Mac |
| --- | --- |
| `npx cap run ios` | Uses your existing web build, builds with Xcode and launches the app |
| `npx cap run ios --list` | Lists the Mac's simulators and connected devices |
| `npx cap run ios -l` | Runs live reload through CapMac |
| `ionic capacitor run ios -l` | Connects the app to the dev server Ionic starts on Windows |
| `npx cap open ios` or `ionic cap build ios` | Opens Xcode on the Mac's screen |
| `npx cap build ios` | Exports a signed IPA into `ios/App/output` |

`cap sync`, `cap copy`, `cap add` and Android commands still run on Windows

CapMac calls this takeover.
A global install turns it on with your first command, and CapMac Studio turns it on when it starts.
After pairing, open a new terminal or restart VS Code so its terminals pick it up

Takeover adds a preload to your Windows user's `NODE_OPTIONS`, so keep `%USERPROFILE%\.capmac\takeover.cjs` in place while it's on.
`capmac takeover off` turns it off, `capmac takeover on` turns it back on, and `CAPMAC_TAKEOVER=0` skips it for one command.
A temporary `npx capmac` copy never turns it on, and neither does `CI=true`

## Commands

| Command | What it does |
| --- | --- |
| `capmac run` | Builds the web app, syncs changes, builds on the Mac, launches the app and streams its console |
| `capmac dev` | Live reload, with automatic rebuilds for native changes |
| `capmac build` | Builds without launching |
| `capmac build --ipa` | Exports a signed IPA to `build/ios/` |
| `capmac build --upload` | Uploads to App Store Connect for TestFlight |
| `capmac targets` | Lists simulators and connected devices |
| `capmac screen` | Shows a simulator in your browser, where you can use it (`--stream compatible` sends pictures instead of video) |
| `capmac screenshot [file]` | Saves a PNG of a simulator, an iPhone or a Mac app's window, and prints its path |
| `capmac logs` | Streams the app's system log from a simulator |
| `capmac doctor --fix` | Checks your setup and repairs what it can |
| `capmac info --files` | Shows the detected project and exactly which files sync, without connecting |
| `capmac sync` | Copies the project to the Mac and runs `cap sync` there, without building or launching |
| `capmac apps` | Lists the apps in this folder and the one in use (`capmac apps use <app>` switches) |
| `capmac backend mac` or `capmac backend wsl` | Builds this project on a paired Mac, or on this PC |
| `capmac wsl setup` | Sets this PC up to build iPhone apps with no Mac |
| `capmac keychain` | Unlocks the Mac's keychain so signing works over SSH |
| `capmac exec -- <command>` | Runs a command in the Mac's copy of the project |
| `capmac pull <path>` | Copies files back from the Mac |
| `capmac open` | Opens the project in Xcode on the Mac |
| `capmac clean` | Deletes build products on the Mac (`--all` deletes the whole copy) |

Use `--target "<name or UDID>"` to pick a simulator or device and `--mac <name>` to pick a paired Mac.
For [projects with several apps](#one-folder-several-apps), `--app ios`, `--app electron`, `--app mac` or `--app windows` picks the app to run

For scripts, `capmac run --no-logs` returns after launch, and `capmac run --for 20` shows the console for 20 seconds and then stops the app.
`capmac run --no-web-build` skips the web build and uses the web files you already built

Build errors use Windows file paths, so you can open them from your terminal.
Add `--os-logs` for NSLog and os_log, `--bridge` for Capacitor plugin traffic, or `--verbose` for full tool output.
`capmac --help` and `capmac <command> --help` list every command and option

## Run on an iPhone

### Through your Mac

Connect or pair the iPhone with the Mac, tap **Trust**, turn on **Developer Mode** and sign in to Xcode on the Mac under **Xcode › Settings › Accounts**

```powershell
capmac run --device
```

CapMac uses the development team your Xcode project names.
If it names none and you belong to several teams, add `--team <TEAM_ID>` or set `ios.team` in `capmac.json`

Signing needs the Mac's login keychain unlocked.
CapMac asks when needed, or you can unlock it before building with `capmac keychain`.
For live reload on a device, the iPhone must be able to reach the Mac's network address

If Xcode reports an expired account session over SSH, use an App Store Connect API key

```powershell
capmac run --device --api-key C:/keys/AuthKey_ABC123XYZ9.p8 --api-issuer "<ISSUER_ID>"
```

You can also set `ios.apiKey` in `capmac.json`, or use `CAPMAC_ASC_KEY_PATH`, `CAPMAC_ASC_KEY_ID` and `CAPMAC_ASC_ISSUER_ID`.
The same key works for IPA exports and uploads

### See a real iPhone's screen

Plug the iPhone into the Mac with a cable and unlock it.
Its screen shows up in Studio when the iPhone is the target, and in your browser with:

```powershell
capmac screen --device
capmac screenshot --device
```

The first time, the Mac asks whether **CapMac** may use the camera, because macOS treats an iPhone's screen as one.
Click **Allow** on the Mac once.
CapMac uses the same capture as QuickTime Player, through a small helper app that stays in the background on the Mac.
The iPhone's camera is never turned on, and its sound keeps playing on the iPhone

The screen is view only for now, so tap and type on the iPhone itself.
Over Wi-Fi alone, the iPhone runs your app but its screen can't be shown

### Without a Mac

Plug the iPhone into your PC. See [Build without a Mac](#build-without-a-mac)

## Build without a Mac

CapMac can build, sign and install Capacitor, Flutter and React Native iPhone apps on Windows, with no Mac.
It's experimental

```powershell
capmac wsl setup
capmac backend wsl
capmac doctor
capmac run
capmac dev
```

`capmac wsl setup` (or **This PC (no Mac)** in CapMac Studio) sets up its own Ubuntu in WSL with every tool, and signs in to Apple once for signing and the Xcode download.
`capmac backend wsl` makes the project build on this PC from now on, in CapMac Studio too, and `capmac backend mac` goes back to the Mac

The iPhone runs over USB, and over Wi-Fi after its first run.
Capacitor apps get live reload, and React Native apps get Fast Refresh, as long as the iPhone can reach your PC on the network.
Flutter apps run release or profile builds, because debug builds need Xcode's debugger, so `capmac dev` rebuilds and reopens a Flutter app each time you save

Some Xcode features have no Linux version yet, such as Metal shaders and Core ML models, and simulators need a Mac.
[iOS on Windows with no Mac](wsl-ios.md) covers setup, signing, Wi-Fi, your own tools and every limit

## Flutter apps

CapMac runs a Flutter app's iOS app, Mac app and Windows app

```powershell
cd my_flutter_app
capmac run                          # the iOS app, in a simulator on the Mac
capmac dev                          # live: each save hot-reloads the app
capmac run --app mac                # the Mac app, on the Mac's desktop
capmac run --app windows            # the Windows app, on this PC (no Mac needed)
capmac run --device --mode release  # on an iPhone, as people get it
capmac build --ipa
```

On the Mac, Flutter itself builds and runs the app (`flutter run`), the way an editor drives it.
CapMac syncs the project and installs Flutter on the Mac the first time, in `~/.capmac/flutter`, apart from any Flutter you install yourself.
It uses this PC's Flutter version, or the one your project pins with FVM or `capmac.json`.
Flutter's steps, the Dart console and the engine's logs come back to Windows, and Dart compile errors use Windows file paths

`capmac dev` hot-reloads the app when you save Dart code or assets.
In the terminal, press `r` to hot reload and `R` to hot restart.
A change to `pubspec.yaml` or to the app's native code rebuilds the app

The Mac app opens behind the windows on the Mac and never takes its keyboard.
Its window comes to Studio and to `capmac screen --app mac`, where you can click, scroll and type.
CapMac reads the window from the surfaces Flutter draws into, so it shows even while the Mac is locked, with no Screen Recording permission

The Windows app runs with Flutter on this PC: yours, or one CapMac installs in `%LOCALAPPDATA%\CapMac\flutter`.
It needs Visual Studio with **Desktop development with C++** and **C++ CMake tools for Windows**.
CapMac checks before building and offers to add what's missing with Visual Studio's installer

Build options are `--mode debug|profile|release`, `--flavor <name>`, `--main lib/main_dev.dart` and `--dart-define KEY=VALUE`.
Defaults for every run go in `capmac.json`:

```json
{ "flutter": { "target": "lib/main_dev.dart", "flavor": "dev", "dartDefines": { "API_URL": "https://dev.example.com" }, "version": "3.47.7" } }
```

In Studio, the toolbar's app picker switches between a Flutter project's apps.
Live mode has **Hot reload** and **Hot restart** buttons, and the **More** menu runs profile and release builds.
**Try a sample › iPhone, Mac and Windows app (Flutter)** makes a small Flutter app with all three ([examples/hello-flutter](../examples/hello-flutter)).
With no Mac, the iOS app builds on this PC too. See [Build without a Mac](#build-without-a-mac)

## React Native apps

CapMac runs a React Native app's iOS app, its Mac app ([react-native-macos](https://github.com/microsoft/react-native-macos)) and its Windows app ([react-native-windows](https://github.com/microsoft/react-native-windows))

```powershell
cd my-react-native-app
capmac run                   # the iOS app, in a simulator on the Mac
capmac dev                   # live: each save shows in the app at once (Fast Refresh)
capmac run --app mac         # the Mac app, on the Mac's desktop
capmac run --app windows     # the Windows app, on this PC (no Mac needed)
capmac run --release         # the JavaScript built into the app, no Metro
```

Metro runs on this PC and serves the app's JavaScript, and CapMac connects the app to it on the Mac.
The Mac installs the app's packages and runs `pod install` when they change, and Xcode builds the app only when something native changed, so after the first build a run takes seconds.
The app's `console.log` lines come back to Windows with its native logs, and a JavaScript error shows its file and line on this PC

`capmac dev` keeps Metro running. Save a file and the app shows it at once, with no build.
In the terminal, press `r` to reload the JavaScript, `j` to open React Native DevTools, `b` to rebuild the app and `B` for a clean rebuild.
A change to `package.json`, a Podfile or the app's native code rebuilds the app

Expo apps run on simulators and iPhones the same way.
If an Expo app has no `ios` folder yet, CapMac makes one with `expo prebuild` the first time it builds the app

The Mac app opens behind the windows on the Mac and never takes its keyboard.
Its window comes to Studio and to `capmac screen --app mac`, and `capmac screenshot --app mac` saves a PNG of it

The Windows app builds with react-native-windows on this PC.
It needs Windows' Developer Mode and Visual Studio 2022 with **Desktop development with C++** and **Universal Windows Platform development**, with its C++ tools.
CapMac checks before building and offers to add what's missing with Visual Studio's installer

Defaults for every run go in `capmac.json`:

```json
{ "reactNative": { "port": 8081, "metroArgs": ["--max-workers", "4"], "podEnv": { "USE_FRAMEWORKS": "static" }, "macosScheme": "MyApp-macOS", "windowsArch": "x64" } }
```

In Studio, the toolbar's app picker switches between the apps.
Live mode has **Reload**, **DevTools**, **Restart app** and **Rebuild** buttons, and the **More** menu runs a release build.
**Try a sample › iPhone, Mac and Windows app (React Native)** makes a small app with all three ([examples/hello-react-native](../examples/hello-react-native)), and offers to install its packages, which Metro needs on this PC.
With no Mac, the iOS app builds on this PC too. See [Build without a Mac](#build-without-a-mac)

## Electron apps

CapMac runs plain Electron, electron-vite and Electron Forge apps, and Capacitor's Electron platform (`@capacitor-community/electron`), on the Mac's desktop

```powershell
cd my-electron-app
capmac run
capmac dev
capmac screen --electron
```

`capmac run` syncs the app, installs its dependencies and Electron for the Mac, builds it and launches it, with the main process and page consoles in your terminal.
Objects in console lines read as they do in DevTools, like `{type: 'roll', value: 6}`.
`capmac dev` reloads the window when you save a page and restarts the app when main process code changes.
electron-vite and Forge projects reload through their own dev command.
In a Capacitor project, add `--electron` or `--target mac` to run the Electron platform, which loads your dev server in live reload

`capmac screen --electron` shows the app's window in your browser, where you can click, scroll, type and use the app's menu shortcuts with Ctrl as ⌘.
`capmac screenshot --electron` saves a PNG of the window.
The Mac needs no Screen Recording or Accessibility permission for this

The Mac sends the window as H.264 video.
A still window sends one frame when a viewer connects, then nothing until it changes.
On slow connections, CapMac lowers the quality and skips frames to keep the stream responsive.
Electron versions older than 30 send screenshots instead, and `--stream compatible` picks screenshots on newer versions too.
CapMac remembers this choice for both the CLI and Studio, where you can change it under **Settings › Screen stream**

Someone may be using the Mac while you work, so the app opens behind their windows and never takes their keyboard.
DevTools and full screen wait until someone switches to the app on the Mac.
After a restart, the app comes back to the front only if someone was using it there

The app's message boxes and file dialogs stay off the Mac's screen too.
They show over the app's window in Studio and `capmac screen --electron`, and in your terminal, where you answer them.
File dialogs browse the Mac's folders, starting in your project's copy on the Mac.
`capmac dialog` lists them and answers one from a script or an AI agent: `capmac dialog 2`, `capmac dialog Discard`, `capmac dialog "~/Documents/photo.png"` or `capmac dialog --cancel`.
Someone who switches to the app on the Mac gets the dialog there instead

In Studio, Electron apps run on **Mac desktop (Electron)** in the target picker and show in a window pane with the Mac's title bar.
**Try a sample** on the home screen makes a small Electron app to start with.
Change how the app is found, built or started in `capmac.json`:

```json
{ "electron": { "dir": "electron", "build": "npm run build", "start": "npm start", "dev": "npm run dev" } }
```

## One folder, several apps

A folder can hold both a Capacitor iOS app and an Electron app for the Mac, and a Flutter or React Native project has an iOS, a Mac and a Windows app.
CapMac finds the apps by reading their files, without running them.
It also checks subfolders in a monorepo

Studio asks which app to use if you haven't chosen one yet.
Opening an app's folder, such as `electron/`, suggests that app.
Use the toolbar's app picker to switch later.
Targets follow your choice: simulators and iPhones for iOS, the Mac desktop for a Mac app, and this PC for a Windows app

The CLI uses the same saved choice:

```powershell
capmac apps                 # the apps here, and the one CapMac uses
capmac apps use electron    # from now on, in the CLI and Studio
capmac run --app ios        # just this once
```

CapMac also recognizes Tauri, .NET MAUI, Cordova, NativeScript and Xcode projects, but can't run them yet

## Configuration

An optional `capmac.json` goes in your app's folder, next to `capacitor.config.*`, `pubspec.yaml` or `package.json`

```json
{
  "host": "studio",
  "ios": { "target": "iPhone 17 Pro", "team": "ABCDE12345", "scheme": "App" },
  "web": { "build": "npm run build", "dev": "npm run dev" },
  "sync": { "exclude": ["docs/", "*.mp4"], "include": [".env.ios"] }
}
```

`host` is the paired Mac to use, by name.
Sync respects `.gitignore`, includes the iOS project and built web assets, and skips `node_modules`, Android, Pods and build output.
In a Capacitor project, videos, design files, pictures over 2 MB and files over 100 MB stay on your PC unless they're in the web assets, a native platform or a local dependency. Your PC builds the web app, so nothing on the Mac reads them.
`capmac info` lists what stays behind, and a `!path` line in `.capmacignore` sends one anyway.
Use `.capmacignore` or the sync settings above to change the file list.
Dependencies are installed on the Mac when needed, and simulator builds reuse native output when only web assets changed

In a monorepo, a Capacitor app syncs from the lockfile root and runs in its own subfolder.
The Mac's copy of a project lives under `~/.capmac/projects/`

## Your Mac and your code

Builds run on a Mac you control, and Xcode and the Mac's keychain handle iOS signing.
CapMac syncs the files the build needs to that Mac over SSH, and sends logs and screens back through the same connection

Pairing checks the Mac's host key and installs a dedicated SSH key without storing your password.
You can also use an SSH key you already have, or the Windows OpenSSH agent.
`capmac info --files` shows what will sync, and `.capmacignore` changes it

CapMac has no account, no server of its own and no telemetry

## Away from the Mac's network

Remote access needs your own [signaling server](../services/signal/deploy/README.md).
Deploy it, then run these commands while your PC is on the Mac's network

```powershell
capmac remote server wss://signal.example.com
capmac remote on
capmac remote status --test
```

CapMac then uses the local network when it can and the internet otherwise, with a direct WebRTC connection, or your server's relay when a direct one isn't possible.
SSH protects the connection either way

The Mac must stay awake and logged in.
`capmac remote set --keep-awake on` keeps it from sleeping while remote access is on.
`capmac remote --help` lists the route, relay and access controls

## AI coding agents

Give your coding agent the same build, run, log and screenshot commands you use.
The CapMac skill works with Claude Code, Codex, GitHub Copilot, Cursor, Gemini CLI, Antigravity, Antigravity CLI, Windsurf, OpenCode, Cline, Kilo Code, Amp, Augment, Goose and JetBrains Junie

```powershell
capmac skill add
```

Choose the agents, and whether to add it for all your projects or just this one.
To skip the questions, use `capmac skill add --agent claude-code,codex --global`.
Start a new agent session afterwards

Studio has the same setup under **Settings › Terminal commands › AI coding agents**.
CapMac for VS Code adds the skill by itself to each project it finds an app in, for the agents it finds, and asks before it replaces a skill that's already there.
**CapMac: Add the CapMac Skill for AI Agents…** adds it again, in the project or for all your projects.
`capmac skill` shows where it's installed, and `capmac skill show` prints it for any other agent

## Troubleshooting

| Problem | Fix |
| --- | --- |
| SSH connection refused | Turn on Remote Login on the Mac |
| Missing Node.js, Xcode setup or iOS runtime | Run `capmac doctor --fix` |
| The simulator won't start | Log in to the Mac's desktop as the paired user |
| Signing reports `errSecInternalComponent` | Unlock the keychain with `capmac keychain` |
| Signing needs a development team | Pass `--team <TEAM_ID>` or set `ios.team` |
| Your Capacitor commands still run on Windows | Check `capmac takeover`, then open a new terminal or restart VS Code |
| The remote Mac is offline | Check that it's awake, logged in and has remote access on |
| No Electron window or page console | Start the app from source. A packaged app, or a launcher that drops `NODE_OPTIONS`, keeps CapMac out |
| A real iPhone's screen stays dark | Plug it into the Mac with a cable, unlock it, and quit QuickTime Player if it shows the same iPhone |
| CapMac isn't allowed to see the iPhone's screen | On the Mac, turn on **CapMac** in System Settings, under Privacy & Security, then Camera |
| The iPhone won't open the app (no Mac) | Turn on Developer Mode. Open Settings on the iPhone, tap Privacy & Security, then Developer Mode |
| A WSL setup or build problem | Run `capmac wsl doctor`, and see [iOS on Windows with no Mac](wsl-ios.md) |

## Building and releasing CapMac

The development commands are in the [README](../README.md#contributing)

`npm run desktop:build` makes x64 and Arm64 installers and portable apps in `apps/desktop/release/<version>/`.
They're unsigned by default, and updates stay off until you set up an update feed.
[Signing and updates](signing-and-updates.md) explains both

Maintainers publish a release with **Actions › Release CapMac Studio**, which can also do a dry run.
It builds Studio and the VS Code extension and publishes the CLI to npm. See [releasing CapMac](releases.md)

The [intro videos](../apps/intro/README.md), one for CapMac and one for CapMac for VS Code, are an editable Remotion project

```powershell
npm ci --prefix apps/intro
npm run intro:studio
npm run intro:render
npm run intro:render:vscode
```

The renders are saved to `out/capmac-intro-v5.mp4` and `out/capmac-vscode-intro-v1.mp4`
