/**
 * CapMac's module for Electron apps (src/electron-hook), bundled, as text: the
 * agent writes it to the Mac when it launches an Electron app. The agent build
 * replaces this module with the real bundle (scripts/agent-build.mjs); from
 * source (tests) it is null.
 */
export const ELECTRON_HOOK_SOURCE: string | null = null;
