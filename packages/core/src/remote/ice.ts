/**
 * ICE servers, from the WebRTC form the signaling server hands out to
 * node-datachannel's. libjuice (node-datachannel's ICE library) relays over
 * UDP only, so TURN over TCP or TLS is left out: CapMac's own relay through
 * the signaling server covers networks without UDP.
 */
import type { IceServerSpec, RelayChoice } from '../shared/remote.js';

export interface NdcIceServer {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  relayType?: 'TurnUdp' | 'TurnTcp' | 'TurnTls';
}

function parseIceUrl(url: string): { scheme: 'stun' | 'stuns' | 'turn' | 'turns'; host: string; port: number; transport: string | null } | null {
  const m = url.trim().match(/^(stuns?|turns?):(\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase() as 'stun' | 'stuns' | 'turn' | 'turns';
  const secure = scheme.endsWith('s');
  return { scheme, host: m[2]!.replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : secure ? 5349 : 3478, transport: m[4]?.toLowerCase() ?? null };
}

/** STUN first (libjuice uses the first one it is given), then UDP TURN unless relaying is off. */
export function toNdcIceServers(specs: IceServerSpec[], relay: RelayChoice): Array<string | NdcIceServer> {
  const stun: string[] = [];
  const turn: NdcIceServer[] = [];
  for (const spec of specs) {
    for (const url of Array.isArray(spec.urls) ? spec.urls : [spec.urls]) {
      const parsed = parseIceUrl(url);
      if (!parsed) continue;
      if (parsed.scheme === 'stun') {
        const host = parsed.host.includes(':') ? `[${parsed.host}]` : parsed.host;
        stun.push(`stun:${host}:${parsed.port}`);
      } else if (parsed.scheme === 'turn' && parsed.transport !== 'tcp' && spec.username && spec.credential) {
        turn.push({ hostname: parsed.host, port: parsed.port, username: spec.username, password: spec.credential, relayType: 'TurnUdp' });
      }
    }
  }
  return relay === 'never' ? [...new Set(stun)] : [...new Set(stun), ...turn];
}
