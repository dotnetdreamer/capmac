# CapMac films

Two editable Remotion films: the CapMac launch film, and one for CapMac for VS Code

Both are 1920 × 1080 at 30 fps with H264 video and stereo AAC audio

## Run

From the repository root

```powershell
npm ci --prefix apps/intro
npm run intro:studio
npm run intro:check
npm run intro:render
npm run intro:render:vscode
npm run intro:poster
npm run intro:poster:vscode
```

| Film | Length | Video | Poster |
| --- | --- | --- | --- |
| CapMac | 84 seconds | `out/capmac-intro-v5.mp4` | `out/capmac-poster-v4.png` |
| CapMac for VS Code | 68 seconds | `out/capmac-vscode-intro-v1.mp4` | `out/capmac-vscode-poster-v1.png` |

The project README plays the film from a copy uploaded to GitHub

Where a page can't play video, `npm --prefix apps/intro run readme` renders `out/capmac-intro-v5.jpg`, the poster with a play button, to link to it instead

`npm --prefix apps/intro run previews -- CapMacIntro` exports a film's review frames into `out/previews/CapMacIntro/`, and `CapMacVSCodeIntro` does the same for the other film

Add frame numbers after the film's name to export just those, like `CapMacIntro 480 title=40`

Both videos are kept in Git. Other generated outputs and dependencies are ignored

This package has its own lockfile and does not change the CLI or desktop dependencies

## CapMac

| Time | Scene | Content |
| --- | --- | --- |
| 0 to 8 s | Build iPhone apps on Windows | The promise, with your Mac or with no Mac at all, and the five frameworks |
| 8 to 16 s | Pair once, keep your commands | `capmac pair` finds the Mac, then `npx cap run ios` runs Orbit on its simulator |
| 16 to 24 s | Live in CapMac Studio | Live lands on the music's drop, each build step finishes on a beat, then the simulator and a tap |
| 24 to 32 s | Save and the app updates | One save updates a Capacitor, a Flutter and a React Native app: live reload, hot reload and Fast Refresh |
| 32 to 36 s | No Mac? Still fine | Studio's Mac picker switches the app to This PC (no Mac) |
| 36 to 46 s | This PC builds it | Setup with one Apple sign-in, then Live builds, signs and installs Orbit on an iPhone over USB, then Wi-Fi |
| 46 to 50 s | Open-source twins | The open-source tool behind each job Xcode does for an iPhone build |
| 50 to 56 s | Mac and Windows apps | One save hot-reloads a Flutter app's Mac window and its Windows window |
| 56 to 62 s | Logs and errors | Console filters and structured output, then an Xcode error that opens at the line on the PC |
| 62 to 68 s | Studio, VS Code or the terminal | The same app in all three front ends |
| 68 to 74 s | Built for AI agents | An agent runs the app and checks a screenshot through the `capmac` command |
| 74 to 79 s | Ready to ship | `capmac build --upload` sends a build to TestFlight |
| 79 to 84 s | Get CapMac | The brand lands on the music's final hit, with Studio, VS Code and npm |

## CapMac for VS Code

One continuous take inside one VS Code window

| Time | Scene | Content |
| --- | --- | --- |
| 0 to 8 s | Your iPhone app in VS Code | The promise and the five frameworks, then VS Code rises into place |
| 8 to 16 s | Open your app's folder | CapMac wakes up, finds the apps of a workspace of three folders and puts Run and Live above the config |
| 16 to 24 s | Live | ⚡ Live lands on the music's drop: a debug session, each step in the Run view, the simulator in a tab beside the code |
| 24 to 30 s | Save and use it | A save to `theme.ts` reloads Orbit, then a click in the screen opens Activity |
| 30 to 38 s | Flutter and React Native | Bloom hot-reloads and keeps its state, Pulse gets Fast Refresh |
| 38 to 44 s | Native code and Problems | A Swift change rebuilds, the Xcode error lands in Problems, a click opens the line and the fix rebuilds |
| 44 to 50 s | Devices and this PC | The Mac's simulators, an iPhone over Wi-Fi, iPhones with no Mac, then a Mac app's window |
| 50 to 58 s | AI agents | Copilot's agent mode runs the app with CapMac's tools after you confirm, and CapMac adds its skill for Claude Code and Codex |
| 58 to 64 s | The whole loop | The window pulls back, then tilts away |
| 64 to 68 s | CapMac for VS Code | The brand lands on the music's final hit |

## What the films show

Product claims come from the [project README](../../README.md) and [CapMac for VS Code's README](../vscode/README.md)

The text on screen comes from [Studio's strings](../desktop/src/shared/i18n/en.ts), [the extension's strings](../vscode/src/i18n.ts) and [the CLI](../../packages/cli/src/commands)

The Studio layout follows the [desktop design](../../docs/desktop-design.md) and [workspace renderer](../desktop/src/renderer/features/workspace), and the VS Code one follows the extension's [screenshots](../vscode/media/screenshots)

The UI and terminal output are illustrative reconstructions for these films

Orbit (Capacitor), Bloom (Flutter) and Pulse (React Native) are fictional demo apps, and the commands are grounded in the repository

Setup with no Mac is shown sped up, with a note, because the first setup takes a while

With no Mac, Studio shows no simulator: the app runs on the iPhone itself, which is what the film shows

The films carry the requirements as notes: a Mac with Xcode and Remote Login, and for building with no Mac, WSL 2, an iPhone and a paid Apple Developer Program membership

## Edit

| File | Purpose |
| --- | --- |
| `src/CapMacIntro.tsx` | The CapMac film: scenes, chapter timings, captions and its poster |
| `src/VSCodeIntro.tsx` | The VS Code film: its timeline, runs, camera, cursor, captions and its poster |
| `src/Film.tsx` | What both films share: fonts, backplates, captions, notes, keys and chips |
| `src/Motion.tsx` | Camera, cursor, word reveals, a window rising into place and a sweep of light |
| `src/Apps.tsx` | Orbit, Bloom and Pulse on iPhones, and Bloom's Mac and Windows windows |
| `src/ProductVisuals.tsx` | CapMac Studio, drawn from a description of each moment |
| `src/NoMac.tsx` | The iPhone on a cable and the open-source twins |
| `src/VSCode.tsx` | VS Code in its Dark Modern theme, with CapMac's views, the screen tab, the Debug Console and chat |
| `src/Root.tsx` | The films and posters |
| `remotion.config.ts` | Render settings and four worker default |
| `scripts/previews.mjs` | Review frames |
| `scripts/atmosphere.py` | Five original procedural cloud backdrops |
| `scripts/prepare_music.py` | Fits the supplied intro.mp3 to each film |
| `scripts/sfx.py` | Synthesizes the click and key sounds |

Animations depend only on the frame number

The camera follows the action through explicit focal coordinates, with zooms between 1× and 2.3×

Decisive moves use a quintic curve, slow pushes drift, and motion blur follows the speed seen on screen

Masked word reveals, cursor ripples and pauses after each result carry the pacing

The music runs at 120 BPM, so a beat is 15 frames: in both films Live is pressed on the drop at 16 seconds, build steps finish on beats and the brand lands on the final hit

Fonts, audio and backdrops are bundled locally and the render waits for fonts to load

Titles use IBM Plex Sans and commands use JetBrains Mono

VS Code's icons come from its codicon font (CC BY 4.0), and the Studio and VS Code reconstructions use the Windows system UI font and Consolas, as the real apps do on Windows

Font licenses are included in `public/fonts/`

The backdrops are `cool`, `warm`, `violet`, `mint` and `blue` in `public/atmosphere/`

To regenerate them, install NumPy and Pillow in your Python environment and run this command from the repository root, naming plates to render only those

```powershell
python apps/intro/scripts/atmosphere.py mint blue
```

The background music is the supplied `public/intro.mp3`

`public/intro-background.wav` (84 seconds) and `public/vscode-background.wav` (68 seconds) keep its opening, repeat a passage from its beat on the original tempo and keep its ending

The films play them at 70 percent volume

To regenerate the music beds, put FFmpeg on PATH and run `npm --prefix apps/intro run music:prepare`

A quiet click plays on each cursor click and a key press on each Ctrl + S, from `public/sfx/`

`npm --prefix apps/intro run sfx` synthesizes them again (it needs NumPy and SciPy), and `Sfx` in `src/Film.tsx` sets their volume

Additional export options are documented in the [Remotion render reference](https://www.remotion.dev/docs/cli/render)
