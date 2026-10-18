# Changelog

## Unreleased

What CapMac Studio could do and CapMac for VS Code couldn't yet

- Remote access settings for each Mac: turn it on, how it connects, the relay, keeping the Mac awake, a connection test, the PCs that can reach it, moving to a new server, turning it off. And the remote access server itself
- Build an IPA: Upload to TestFlight, the Team ID and the folder it goes to
- The Devices view: a Mac's macOS, Xcode, chip and simulators, Copy UDID, and what an iPhone needs before your app can open on it
- The Apps view: how much a sync copies to the Mac
- Building on this PC: Run without building and a React Native release run work there too. Rebuild and Clean Rebuild work whenever the app can run
- Setting up this PC: the paid Apple developer account note up front, and Details when setup stops
- **Remove the CapMac Skill for AI Agents…**
- The `capmac.problems.packageWarnings` setting

## 0.1.1

The first version of CapMac for VS Code.

- Finds the apps in the open folder: Capacitor and Ionic (iPhone and Electron apps), Flutter and React Native (iPhone, Mac and Windows apps) and Electron; recognises Expo, Tauri, .NET MAUI, Cordova and NativeScript apps.
- Workspaces of several folders and monorepos: the apps of each folder, each folder's entries in Run and Debug, several apps running at once.
- Run and Live as VS Code debug sessions: the app's console in the Debug Console, Stop, Restart and Hot Reload on the debug toolbar, commands typed in the Debug Console.
- The live screen of simulators, iPhones plugged into the Mac, and Mac app windows, in a tab: touch, scroll, type, screenshots, the app's dialogs.
- Build errors in Problems, at the line in your files: Xcode, Swift and Dart from the Mac; TypeScript, esbuild and Vite from the web build.
- The Run, Apps and Devices views, the status bar, CodeLens and a walkthrough.
- Pairing, health checks with fixes, simulators, remote access and the keychain, from VS Code.
- Building on this PC with no Mac: setup, iPhones over USB and Wi-Fi, IPA builds.
- Tools for AI agents: status, run, stop, screenshot and logs.
- CapMac's skill for coding agents (Claude Code, Codex, Gemini CLI, Cursor, Antigravity and others), added by itself to each project with an app for the agents CapMac finds, never over a skill that is already there without asking. **Add the CapMac Skill for AI Agents…** adds it again, in the project or for all projects.
- The `capmac` command in VS Code's terminals and in the agents other extensions start (the Claude Code and Codex panels).
