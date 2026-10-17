# CapMac intro

An editable 68 second Remotion film showing how CapMac builds Capacitor and Ionic iOS apps from Windows through a paired Mac

The opening puts the purpose and priority features first, with familiar Ionic and Capacitor commands on Windows, SSH pairing choices and access to the Mac over the internet before the Studio demonstration

The export is 1920 × 1080 at 30 fps with H264 video and stereo AAC audio

## Run

From the repository root

```powershell
npm ci --prefix apps/intro
npm run intro:studio
npm run intro:check
npm run intro:render
npm run intro:poster
```

The video is `out/capmac-intro-v4.mp4` and the poster is `out/capmac-poster-v3.png`

Run `npm --prefix apps/intro run previews` to export 28 review frames into `out/intro-v3-frames/`

The final video at `out/capmac-intro-v4.mp4` is kept in Git

Other generated outputs and dependencies are ignored

This package has its own lockfile and does not change the CLI or desktop dependencies

## Scenes

| Time | Scene | Content |
| --- | --- | --- |
| 0 to 6 s | Purpose and features | Build iOS apps from Windows, familiar commands, remote login and live reload |
| 6 to 14 s | Your usual commands | Focal zooms into `ionic capacitor run ios` and `npx cap run ios` in a Windows terminal with results held on screen |
| 14 to 21 s | Remote Login and pairing | Enable Remote Login on the Mac, then show password once, an existing SSH key and Windows OpenSSH agent authentication |
| 21 to 28 s | Internet access | Remote access activation, automatic or explicit connection routes, relay choices and keeping the Mac awake |
| 28 to 36 s | Studio build | Click Live, follow the build timeline, zoom into the simulator and tap Activity |
| 36 to 44 s | Ionic live reload | Run `ionic capacitor run ios -l`, edit the theme, show the HMR update in the app and click Home |
| 44 to 52 s | Inspect the app | Console source filter, expanded JSON, clickable problem path and editor source line |
| 52 to 61 s | CLI tools | One persistent terminal for screenshots, coding agent setup and signed upload |
| 61 to 68 s | Install CapMac | Brand, purpose and `npm install -g capmac` |

Product claims come from the [project README](../../README.md) and [CLI implementation](../../packages/cli/src/main.ts)

The Studio layout follows the [desktop design](../../docs/desktop-design.md) and [workspace renderer](../desktop/src/renderer/features/workspace)

The UI and terminal output are illustrative reconstructions for this film

Orbit is a fictional Capacitor demo app and the commands are grounded in the repository

The film includes the Mac, Xcode and signing requirements

To use the same Ionic and Capacitor commands on Windows, install a lasting copy of CapMac or launch the packaged Studio app, pair the Mac and open a new terminal or restart VS Code

Enable macOS Remote Login before pairing and keep the Mac awake with a logged in desktop session for the simulator

Internet access needs your configured signaling server and initial activation while this PC is on the Mac network

The [project setup instructions](../../README.md#quick-start), [command compatibility](../../docs/guide.md#your-capacitor-and-ionic-commands) and [remote access setup](../../docs/guide.md#away-from-the-macs-network) explain these requirements

## Edit

| File | Purpose |
| --- | --- |
| `src/CapMacIntro.tsx` | Copy, scenes, chapter timings, colors and transitions |
| `src/Motion.tsx` | Camera focal coordinates, zooms, pans, motion blur, masked text and cursor ripples |
| `src/ProductVisuals.tsx` | Phone demo and Studio reconstruction |
| `src/RemoteFeatures.tsx` | Mac Remote Login, CLI authentication examples and CapMac remote access choices |
| `src/Root.tsx` | Resolution, frame rate and duration |
| `remotion.config.ts` | Render settings and four worker default |
| `scripts/previews.mjs` | Review frame exports |
| `scripts/atmosphere.py` | Three original procedural cloud backdrops |
| `scripts/prepare_music.py` | Fit the supplied intro.mp3 to the film |

Animations depend only on the frame number

The camera follows the action through explicit focal coordinates, moving from a wide workspace view into zooms between 1× and 2.3×

Eased pans guide attention to the command, click or result, with pullbacks between actions and blur driven by camera velocity

Masked text entrances, cursor ripples and pauses after each result carry the pacing through the film

The approach takes its inspiration from product demonstrations where the viewer sees an action, follows a close view of its result and returns to the surrounding workspace

Fonts, audio and backdrops are bundled locally and the render waits for fonts to load

Titles use IBM Plex Sans and commands use JetBrains Mono

The Studio reconstruction uses the Windows system UI font

Font licenses are included in `public/fonts/`

The three backdrops are `public/atmosphere/cool.jpg`, `public/atmosphere/warm.jpg` and `public/atmosphere/violet.jpg`

The background music is the supplied `intro.mp3`, copied from Downloads to `public/intro.mp3`

The prepared `public/intro-background.wav` repeats a matching middle passage at the original tempo, then fades with the closing card

The composition plays the prepared track at 70 percent volume and replaces the previous score entirely

To regenerate the music bed, put FFmpeg on PATH and run `npm --prefix apps/intro run music:prepare`

To regenerate the backdrop assets, install NumPy and Pillow in your Python environment and run this command from the repository root

```powershell
python apps/intro/scripts/atmosphere.py
```

Scene changes fall at 6, 14, 21, 28, 36, 44, 52 and 61 seconds

Additional export options are documented in the [Remotion render reference](https://www.remotion.dev/docs/cli/render)
