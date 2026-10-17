/**
 * The extension's engine process: CapMac Studio's engine host, unchanged,
 * behind a stand-in for Electron's parent port. Runs as Node.js (VS Code's own
 * runtime with ELECTRON_RUN_AS_NODE), so SSH, hashing and compression never
 * slow down VS Code's extension host.
 */
import './parent-port.js';
import '../../../desktop/src/engine/host.js';
