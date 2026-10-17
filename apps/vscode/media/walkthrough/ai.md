# Your AI agent can run the app

CapMac gives AI agents in VS Code (like Copilot's agent mode) five tools:

| Tool | What the agent can do |
| --- | --- |
| `#capmacStatus` | See the apps, where they run, and how the last run went |
| `#capmacRun` | Build and run the app (you confirm first) |
| `#capmacScreenshot` | Look at the app's screen |
| `#capmacLogs` | Read the app's console |
| `#capmacStop` | Stop it |

Try: *“Run my app, open the settings screen and tell me if anything looks broken.”*

Claude Code, Codex, Gemini CLI and other coding agents use the `capmac` command, which CapMac adds to VS Code's terminals and to the agents VS Code starts. CapMac's skill teaches it to them: CapMac adds the skill to your project for the agents it finds, and **CapMac: Add the CapMac Skill for AI Agents…** adds it again, in this project or for all your projects.
