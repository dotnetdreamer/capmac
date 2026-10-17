# Run it, live

Press **⚡ Live** or **▶ Run** in the CapMac view, on the status bar, or above your `capacitor.config` or `pubspec.yaml`.

| | What happens |
| --- | --- |
| **⚡ Live** | Builds, opens the app and keeps it running. Save a file and the app updates (Flutter hot-reloads) |
| **▶ Run** | Builds and opens the app once |

Every run is a VS Code debug session, so the usual keys work. Pick **Live: your app** once in **Run and Debug** (no launch.json needed), then:

| Press | What happens |
| --- | --- |
| **F5** | Live |
| **Shift+F5** | Stop |
| **Ctrl+Shift+F5** | Restart the app (Flutter: hot restart) |
| **Ctrl+F5** while live | Hot reload (Flutter), reload the JavaScript (React Native), reload the windows (Electron) |

The app's console (`console.log`, Dart's `print`, native logs) streams into the **Debug Console**, with links to the line that logged. Build errors go to **Problems**, at the line in your code. Type `r`, `R`, `b`, `s` or `q` in the Debug Console to reload, restart, rebuild, take a screenshot or stop.

The **Run** view shows each build step as it happens.
