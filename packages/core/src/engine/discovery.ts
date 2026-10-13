import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Bonjour } from 'bonjour-service';

export interface DiscoveredMac {
  name: string;
  host: string;
  port: number;
  addresses: string[];
  /** How it was found: on this network (Bonjour), or on your tailnet (Tailscale). */
  via?: 'bonjour' | 'tailscale';
}

/**
 * Finds Macs with Remote Login enabled: macOS advertises `_ssh._tcp` over
 * Bonjour when SSH is on (the same trick Xamarin's Pair to Mac used). With
 * Tailscale installed, the Macs on your tailnet are listed too.
 */
export async function discoverMacs(timeoutMs = 2500): Promise<DiscoveredMac[]> {
  const [local, tailnet] = await Promise.all([discoverBonjourMacs(timeoutMs), discoverTailscaleMacs(Math.max(timeoutMs, 3000))]);
  const seen = new Set(local.map((m) => m.host.toLowerCase()));
  return [...local, ...tailnet.filter((m) => !seen.has(m.host.toLowerCase()))];
}

async function discoverBonjourMacs(timeoutMs: number): Promise<DiscoveredMac[]> {
  let bonjour: Bonjour | null = null;
  const found = new Map<string, DiscoveredMac>();
  try {
    bonjour = new Bonjour({}, () => undefined);
    const browser = bonjour.find({ type: 'ssh' }, (service: any) => {
      const host = String(service.host ?? '').replace(/\.$/, '');
      if (!host) return;
      found.set(`${host}:${service.port}`, {
        name: String(service.name ?? host),
        host,
        port: Number(service.port) || 22,
        addresses: (service.addresses ?? []).filter((a: string) => /^\d+\.\d+\.\d+\.\d+$/.test(a)),
        via: 'bonjour',
      });
    });
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    browser.stop();
  } catch {
    // mDNS blocked (firewall/VPN): the user can still type a host name.
  } finally {
    try {
      bonjour?.destroy();
    } catch {
      // ignore
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Tailscale's CLI, when it is installed. */
function tailscaleCommand(): string | null {
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\Program Files']) {
      const exe = base ? `${base}\Tailscale\tailscale.exe` : null;
      if (exe && existsSync(exe)) return exe;
    }
    return 'tailscale.exe';
  }
  if (process.platform === 'darwin' && existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale')) return '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  return 'tailscale';
}

interface TailscalePeer {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  Online?: boolean;
  TailscaleIPs?: string[];
}

/** The online Macs in `tailscale status --json` output (MagicDNS names when there are some). */
export function parseTailscaleStatus(json: string): DiscoveredMac[] {
  let status: { Peer?: Record<string, TailscalePeer> };
  try {
    status = JSON.parse(json);
  } catch {
    return [];
  }
  const macs: DiscoveredMac[] = [];
  for (const peer of Object.values(status.Peer ?? {})) {
    if (peer.OS !== 'macOS' || peer.Online === false) continue;
    const v4 = (peer.TailscaleIPs ?? []).filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    const host = (peer.DNSName ?? '').replace(/\.$/, '') || v4[0];
    if (!host) continue;
    macs.push({ name: peer.HostName || host.split('.')[0]!, host, port: 22, addresses: v4, via: 'tailscale' });
  }
  return macs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Macs on your tailnet (empty when Tailscale is not installed or not running). */
export function discoverTailscaleMacs(timeoutMs = 3000): Promise<DiscoveredMac[]> {
  const command = tailscaleCommand();
  if (!command) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(command, ['status', '--json'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : parseTailscaleStatus(stdout));
    });
  });
}
