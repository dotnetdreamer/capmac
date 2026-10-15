// The main process: one window, a menu with a shortcut, IPC the page can call, and native dialogs.
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen } = require('electron');
const fs = require('node:fs');
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

/** The Mac's own dialogs, each kind once. */
async function showDialog(kind, win) {
  switch (kind) {
    case 'question': {
      const buttons = ['Keep', 'Discard', 'Cancel'];
      const r = await dialog.showMessageBox(win, { type: 'question', message: 'Keep your changes?', detail: 'dialog.showMessageBox, as a sheet on the window.', buttons, defaultId: 0, cancelId: 2, checkboxLabel: 'Don’t ask again' });
      return `You picked “${buttons[r.response]}”${r.checkboxChecked ? ' and “Don’t ask again”' : ''}`;
    }
    case 'wait': {
      const r = dialog.showMessageBoxSync({ type: 'warning', message: 'The main process waits for you', detail: 'dialog.showMessageBoxSync blocks the main process until you answer.', buttons: ['OK', 'Cancel'] });
      return r === 0 ? 'You said OK' : 'You cancelled';
    }
    case 'open': {
      const r = await dialog.showOpenDialog(win, { title: 'Open pictures', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif'] }, { name: 'All Files', extensions: ['*'] }] });
      return r.canceled ? 'Nothing opened' : `Opened ${r.filePaths.join(', ')}`;
    }
    case 'save': {
      const r = await dialog.showSaveDialog(win, { title: 'Save the note', defaultPath: path.join(app.getPath('documents'), 'hello-note.txt'), filters: [{ name: 'Text', extensions: ['txt'] }] });
      if (r.canceled || !r.filePath) return 'Not saved';
      fs.writeFileSync(r.filePath, `Saved by Hello Electron at ${new Date().toLocaleString()}\n`);
      return `Saved ${r.filePath}`;
    }
    case 'error':
      dialog.showErrorBox('Something went wrong', 'dialog.showErrorBox shows this, and the main process waits until you close it.');
      return 'The error was shown';
    default:
      return 'Unknown dialog';
  }
}

ipcMain.handle('dialog', async (event, kind) => {
  const result = await showDialog(kind, BrowserWindow.fromWebContents(event.sender));
  console.log(`Main process: ${result}`);
  return result;
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
    {
      label: 'Dialogs',
      submenu: [
        ['Ask a Question…', 'question', '1'],
        ['Ask and Wait…', 'wait', '2'],
        ['Open a File…', 'open', '3'],
        ['Save a File…', 'save', '4'],
        ['Show an Error', 'error', '5'],
      ].map(([label, kind, key]) => ({
        label,
        accelerator: `CmdOrCtrl+Shift+${key}`,
        click: (_item, win) => void showDialog(kind, win ?? undefined).then((result) => {
          console.log(`Main process: ${result}`);
          win?.webContents.send('dialog-result', result);
        }),
      })),
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
