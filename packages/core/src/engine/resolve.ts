import dns from 'node:dns/promises';
import net from 'node:net';
// @ts-expect-error multicast-dns ships no type definitions
import makeMdns from 'multicast-dns';

export interface ResolvedAddress {
  address: string;
  via: 'literal' | 'dns' | 'mdns' | 'cache' | 'unresolved';
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

/** Asks the local network directly ("who is mac-name.local?") over multicast DNS. */
export function mdnsLookup(name: string, timeoutMs = 2500): Promise<string | null> {
  return new Promise((resolve) => {
    let mdns: any;
    try {
      mdns = makeMdns();
    } catch {
      resolve(null);
      return;
    }
    const target = name.replace(/\.$/, '').toLowerCase();
    let settled = false;
    const done = (ip: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        mdns.destroy();
      } catch {
        // ignore
      }
      resolve(ip);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    mdns.on('response', (response: any) => {
      for (const record of [...(response.answers ?? []), ...(response.additionals ?? [])]) {
        if (record.type === 'A' && String(record.name).toLowerCase() === target) {
          done(String(record.data));
          return;
        }
      }
    });
    mdns.on('error', () => done(null));
    mdns.query({ questions: [{ name: target, type: 'A' }] });
  });
}

/**
 * Finds the Mac's IP address. Windows' own resolver is flaky for `.local`
 * names, so fall back to asking the network ourselves, then to the address
 * that worked last time. (Safe: the SSH host key is still verified.)
 */
export async function resolveMacAddress(host: string, lastKnown?: string): Promise<ResolvedAddress> {
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return { address: host.replace(/^\[|\]$/g, ''), via: 'literal' };
  try {
    const all = await timeout(dns.lookup(host, { all: true }), 5000);
    const v4 = all.find((a) => a.family === 4) ?? all[0];
    if (v4) return { address: v4.address, via: 'dns' };
  } catch {
    // fall through
  }
  if (/\.local\.?$/i.test(host)) {
    const ip = await mdnsLookup(host);
    if (ip) return { address: ip, via: 'mdns' };
  }
  if (lastKnown) return { address: lastKnown, via: 'cache' };
  return { address: host, via: 'unresolved' };
}
