// The page: everything it logs shows up in CapMac's console as JS.
console.log('Hello Electron! The page is ready');

async function showSystem() {
  const list = document.getElementById('system');
  try {
    const info = await window.hello.systemInfo();
    const os = info.platform === 'darwin' ? `macOS ${info.system}` : `${info.platform} ${info.system}`;
    const rows = {
      System: `${os} (${info.arch === 'arm64' ? 'Apple silicon' : info.arch})`,
      Computer: info.computer,
      Electron: info.electron,
      Chromium: info.chrome,
      'Node.js': info.node,
      Display: info.scale > 1 ? `Retina (${info.scale}×)` : `${info.scale}×`,
    };
    list.innerHTML = Object.entries(rows).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    document.getElementById('sub').textContent = `An Electron app, running on ${os}, edited on a PC.`;
    console.log('System', JSON.stringify(info));
  } catch (err) {
    list.innerHTML = `<dt>Error</dt><dd>${err?.message ?? err}</dd>`;
    console.error('Reading the system info failed', err);
  }
}

let count = 0;
document.getElementById('count').addEventListener('click', () => {
  count += 1;
  document.getElementById('count').textContent = `Clicked ${count} time${count === 1 ? '' : 's'}`;
  console.log(`Counter: ${count}`);
  if (count % 5 === 0) console.warn(`That is a lot of clicks (${count})`);
});

document.getElementById('ping').addEventListener('click', async () => {
  const answer = await window.hello.ping();
  document.getElementById('pong').textContent = `Pong ${answer.pings} at ${answer.at} from process ${answer.pid}`;
});

const note = document.getElementById('note');
note.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !note.value) return;
  console.log(`Note: ${note.value}`);
  document.getElementById('echo').textContent = `Logged “${note.value}”`;
  note.value = '';
});

window.hello.onSayHello(() => {
  console.log('Hello from the menu (⌘⇧H)');
  document.getElementById('echo').textContent = 'The Hello menu said hello';
});

// Native dialogs, shown by the main process.
for (const kind of ['question', 'wait', 'open', 'save', 'error']) {
  document.getElementById(`dlg-${kind}`).addEventListener('click', async () => {
    const result = await window.hello.dialog(kind);
    document.getElementById('dialog-result').textContent = result;
  });
}

window.hello.onDialogResult((result) => {
  document.getElementById('dialog-result').textContent = result;
});

// Something long enough to scroll.
document.getElementById('list').innerHTML = Array.from({ length: 40 }, (_, i) => `<li>Item ${i + 1}</li>`).join('');

showSystem();
