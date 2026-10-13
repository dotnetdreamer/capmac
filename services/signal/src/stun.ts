/**
 * A STUN server (RFC 5389 Binding only): tells a PC or a door which public
 * address and port its UDP packets come from, so the two can punch through
 * their routers to each other. It keeps no state.
 */
import dgram from 'node:dgram';
import zlib from 'node:zlib';

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;
const SOFTWARE = 0x8022;
const FINGERPRINT = 0x8028;
const FINGERPRINT_XOR = 0x5354554e;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  const native = (zlib as unknown as { crc32?: (data: Uint8Array) => number }).crc32;
  if (native) return native(data) >>> 0;
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function attribute(type: number, value: Buffer): Buffer {
  const padded = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
  padded.writeUInt16BE(type, 0);
  padded.writeUInt16BE(value.length, 2);
  value.copy(padded, 4);
  return padded;
}

/** The XOR-MAPPED-ADDRESS value for `address:port` (IPv4 or IPv6). */
export function xorMappedAddress(address: string, port: number, transactionId: Buffer): Buffer {
  const v6 = address.includes(':');
  const value = Buffer.alloc(v6 ? 20 : 8);
  value.writeUInt8(0, 0);
  value.writeUInt8(v6 ? 0x02 : 0x01, 1);
  value.writeUInt16BE((port ^ (MAGIC_COOKIE >>> 16)) & 0xffff, 2);
  if (!v6) {
    const parts = address.split('.').map(Number);
    const ip = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
    value.writeUInt32BE((ip ^ MAGIC_COOKIE) >>> 0, 4);
    return value;
  }
  const bytes = ipv6Bytes(address);
  const key = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), transactionId]);
  for (let i = 0; i < 16; i++) value[4 + i] = bytes[i]! ^ key[i]!;
  return value;
}

function ipv6Bytes(address: string): Buffer {
  const clean = address.replace(/%.*$/, '');
  // IPv4-mapped (::ffff:1.2.3.4)
  const mapped = clean.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let text = clean;
  if (mapped) {
    const v4 = mapped[2]!.split('.').map(Number);
    text = `${mapped[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - headParts.length - tailParts.length;
  const groups = [...headParts, ...Array<string>(fill).fill('0'), ...tailParts];
  const out = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16) & 0xffff, i * 2));
  return out;
}

/** The response to a Binding request, or null when `packet` is not one. */
export function bindingResponse(packet: Buffer, address: string, port: number, software = 'capmac-signal'): Buffer | null {
  if (packet.length < 20 || packet.readUInt16BE(0) !== BINDING_REQUEST || packet.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  if (packet.readUInt16BE(2) + 20 !== packet.length) return null;
  const transactionId = packet.subarray(8, 20);
  const attributes = Buffer.concat([
    attribute(XOR_MAPPED_ADDRESS, xorMappedAddress(address, port, transactionId)),
    attribute(SOFTWARE, Buffer.from(software, 'utf8')),
  ]);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(attributes.length + 8, 2); // the FINGERPRINT attribute counts
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  const body = Buffer.concat([header, attributes]);
  const fingerprint = Buffer.alloc(4);
  fingerprint.writeUInt32BE((crc32(body) ^ FINGERPRINT_XOR) >>> 0, 0);
  return Buffer.concat([body, attribute(FINGERPRINT, fingerprint)]);
}

export interface StunServer {
  ports: number[];
  close(): Promise<void>;
}

/** Answers STUN Binding requests on `port`, over IPv4 and (when available) IPv6. */
export async function startStun(port: number, host4 = '0.0.0.0', host6 = '::'): Promise<StunServer> {
  const sockets: dgram.Socket[] = [];
  const bind = (type: 'udp4' | 'udp6', host: string) =>
    new Promise<dgram.Socket | null>((resolve) => {
      const socket = dgram.createSocket({ type, ipv6Only: type === 'udp6' });
      socket.on('message', (msg, rinfo) => {
        const response = bindingResponse(msg, rinfo.address, rinfo.port);
        if (response) socket.send(response, rinfo.port, rinfo.address);
      });
      socket.once('error', () => {
        socket.close();
        resolve(null);
      });
      socket.bind(port, host, () => resolve(socket));
    });
  const v4 = await bind('udp4', host4);
  if (!v4) throw new Error(`Could not listen for STUN on UDP ${host4}:${port}.`);
  sockets.push(v4);
  const v6 = await bind('udp6', host6);
  if (v6) sockets.push(v6);
  return {
    ports: sockets.map((s) => s.address().port),
    close: async () => {
      await Promise.all(sockets.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    },
  };
}
