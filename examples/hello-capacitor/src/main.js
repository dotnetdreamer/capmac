import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';

console.log(`Hello capmac! Running on ${Capacitor.getPlatform()}`);

async function showDevice() {
  const list = document.getElementById('device');
  try {
    const info = await Device.getInfo();
    const battery = await Device.getBatteryInfo().catch(() => null);
    const rows = {
      Model: info.model,
      OS: `${info.operatingSystem} ${info.osVersion}`,
      Platform: info.platform,
      Virtual: info.isVirtual ? 'yes (simulator)' : 'no',
      // Simulators report -1 for the battery level.
      Battery: battery?.batteryLevel != null && battery.batteryLevel >= 0 ? `${Math.round(battery.batteryLevel * 100)}%` : 'n/a',
    };
    list.innerHTML = Object.entries(rows).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    console.log('Device info', JSON.stringify(info));
  } catch (err) {
    list.innerHTML = `<dt>Error</dt><dd>${err?.message ?? err}</dd>`;
    console.error('Device.getInfo failed', err);
  }
}

let count = 0;
document.getElementById('count').addEventListener('click', () => {
  count += 1;
  document.getElementById('count').textContent = `Tapped ${count} time${count === 1 ? '' : 's'}`;
  console.log(`Counter: ${count}`);
  if (count % 5 === 0) console.warn(`That is a lot of taps (${count})`);
});

const note = document.getElementById('note');
note.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !note.value) return;
  console.log(`Note: ${note.value}`);
  document.getElementById('echo').textContent = `Logged “${note.value}”`;
  note.value = '';
});

// Something long enough to scroll.
document.getElementById('list').innerHTML = Array.from({ length: 40 }, (_, i) => `<li>Item ${i + 1}</li>`).join('');

showDevice();
