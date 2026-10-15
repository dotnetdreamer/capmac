// The main process: one window, a menu with a shortcut, and IPC the page can call.
const { app, BrowserWindow, ipcMain, Menu, nativeTheme, screen } = require('electron');
const os = require('node:os');
const path = require('node:path');

let pings = 0;

function createWindow() {
  const win = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 480,
    minHeight: 360,
    title: 'Hello Electron',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1013' : '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('system-info', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  return {
    platform: process.platform,
    arch: process.arch,
    system: process.getSystemVersion(),
    computer: os.hostname(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    scale: display.scaleFactor,
  };
});

ipcMain.handle('ping', () => {
  pings += 1;
  console.log(`Main process: ping ${pings} from the window`);
  return { pings, pid: process.pid, at: new Date().toLocaleTimeString() };
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Hello',
      submenu: [
        {
          label: 'Say Hello',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: (_item, win) => {
            console.log('Main process: Say Hello from the menu');
            win?.webContents.send('say-hello');
          },
        },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
  console.log(`Hello Electron starting on ${process.platform} ${process.getSystemVersion()} (${process.arch}), Electron ${process.versions.electron}`);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// A sample: quit with its last window (a Mac app would usually keep running).
app.on('window-all-closed', () => app.quit());
