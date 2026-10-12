import { Bonjour } from 'bonjour-service';

export interface DiscoveredMac {
  name: string;
  host: string;
  port: number;
  addresses: string[];
}

/**
 * Finds Macs with Remote Login enabled: macOS advertises `_ssh._tcp` over
 * Bonjour when SSH is on (the same trick Xamarin's Pair to Mac used).
 */
export async function discoverMacs(timeoutMs = 2500): Promise<DiscoveredMac[]> {
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
