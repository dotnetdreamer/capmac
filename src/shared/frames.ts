/**
 * Wire format between the Windows CLI and the Mac agent.
 *
 * The agent runs as an SSH exec channel. Both directions carry a sequence of
 * frames: `[u32 BE length][u8 kind][payload]`, where `length` counts the kind
 * byte plus the payload. Kind 0 is a UTF-8 JSON message; kind 1 is an opaque
 * binary chunk whose meaning comes from the JSON message sent before it.
 *
 * The agent prints AGENT_MAGIC before its first frame, so the client can skip
 * anything a user's shell startup files print to stdout (.zshenv echo, etc).
 */

export const AGENT_MAGIC = '\n@@CAPMAC-AGENT-1@@\n';

export const FRAME_JSON = 0;
export const FRAME_BINARY = 1;

/** Hard upper bound for a single frame. Binary payloads are chunked well below this. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Preferred size for binary chunks (file uploads, downloads). */
export const BINARY_CHUNK_BYTES = 256 * 1024;

export type Frame =
  | { kind: 'json'; value: any }
  | { kind: 'binary'; data: Buffer };

function header(kind: number, payloadLength: number): Buffer {
  const h = Buffer.allocUnsafe(5);
  h.writeUInt32BE(payloadLength + 1, 0);
  h.writeUInt8(kind, 4);
  return h;
}

export function encodeJson(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length + 1 > MAX_FRAME_BYTES) throw new Error(`JSON frame too large (${body.length} bytes)`);
  return Buffer.concat([header(FRAME_JSON, body.length), body]);
}

export function encodeBinary(data: Buffer): Buffer {
  if (data.length + 1 > MAX_FRAME_BYTES) throw new Error(`Binary frame too large (${data.length} bytes)`);
  return Buffer.concat([header(FRAME_BINARY, data.length), data]);
}

/**
 * Incremental frame parser. Keeps incoming chunks in a list and only
 * concatenates once a whole frame is available, so large frames arriving in
 * many small SSH packets are not re-copied on every chunk.
 */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private frameSize = -1;

  push(chunk: Buffer): Frame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const frames: Frame[] = [];
    for (;;) {
      if (this.frameSize < 0) {
        if (this.buffered < 4) break;
        const length = this.peekLength();
        if (length < 1 || length > MAX_FRAME_BYTES) {
          throw new Error(`Corrupt frame stream (frame length ${length})`);
        }
        this.frameSize = 4 + length;
      }
      if (this.buffered < this.frameSize) break;
      const frame = this.take(this.frameSize);
      this.frameSize = -1;
      const kind = frame[4];
      const payload = frame.subarray(5);
      if (kind === FRAME_JSON) {
        frames.push({ kind: 'json', value: JSON.parse(payload.toString('utf8')) });
      } else if (kind === FRAME_BINARY) {
        frames.push({ kind: 'binary', data: payload });
      } else {
        throw new Error(`Corrupt frame stream (unknown frame kind ${kind})`);
      }
    }
    return frames;
  }

  /** Bytes received but not yet returned as frames. */
  get pending(): number {
    return this.buffered;
  }

  private peekLength(): number {
    const first = this.chunks[0]!;
    if (first.length >= 4) return first.readUInt32BE(0);
    return Buffer.concat(this.chunks).readUInt32BE(0);
  }

  private take(n: number): Buffer {
    const parts: Buffer[] = [];
    let remaining = n;
    while (remaining > 0) {
      const chunk = this.chunks[0]!;
      if (chunk.length <= remaining) {
        parts.push(chunk);
        this.chunks.shift();
        remaining -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, remaining));
        this.chunks[0] = chunk.subarray(remaining);
        remaining = 0;
      }
    }
    this.buffered -= n;
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, n);
  }
}

/**
 * Finds AGENT_MAGIC in a byte stream. Everything before it is returned as
 * `noise` (shell startup chatter); everything after goes to the frame decoder.
 */
export class MagicScanner {
  private seen = Buffer.alloc(0);
  private found = false;
  private readonly magic = Buffer.from(AGENT_MAGIC, 'utf8');
  noise = '';

  /** Returns bytes that follow the magic marker, or null while still scanning. */
  push(chunk: Buffer): Buffer | null {
    if (this.found) return chunk;
    this.seen = Buffer.concat([this.seen, chunk]);
    const index = this.seen.indexOf(this.magic);
    if (index < 0) {
      if (this.seen.length > 1024 * 1024) {
        throw new Error(`Agent did not start. Output was:\n${this.seen.toString('utf8', 0, 4000)}`);
      }
      return null;
    }
    this.found = true;
    this.noise = this.seen.toString('utf8', 0, index);
    const rest = this.seen.subarray(index + this.magic.length);
    this.seen = Buffer.alloc(0);
    return rest;
  }

  get started(): boolean {
    return this.found;
  }

  /** Text received so far while the marker has not been seen (for error messages). */
  get partial(): string {
    return this.seen.toString('utf8');
  }
}
