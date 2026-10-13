/**
 * Byte streams for SSH over remote access: a WebRTC data channel, or a relay
 * WebSocket, as a Node.js Duplex (what ssh2 takes as its `sock`, and what the
 * door pipes to sshd). SSH must never lose or reorder a byte, so both hold
 * writes back while their send buffer is full instead of dropping data.
 */
import { Duplex } from 'node:stream';
import type { DataChannel } from './native.js';

/** Unsent bytes above this hold writes back; they resume below LOW. */
const HIGH = 1024 * 1024;
const LOW = 256 * 1024;

/**
 * A data channel as a Duplex. Writes are split to the channel's message size;
 * node-datachannel's own DataChannelStream drops messages when its buffer is
 * full, which would corrupt SSH, so this one waits instead.
 */
export function dataChannelDuplex(dc: DataChannel): Duplex {
  const maxMessage = Math.max(1024, Math.min(64 * 1024, dc.maxMessageSize() || 64 * 1024));
  let waiting: (() => void) | null = null;
  let closed = false;
  dc.setBufferedAmountLowThreshold(LOW);
  dc.onBufferedAmountLow(() => {
    const resume = waiting;
    waiting = null;
    resume?.();
  });
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (closed) {
        callback(new Error('The connection to the Mac closed.'));
        return;
      }
      try {
        for (let offset = 0; offset < chunk.length; offset += maxMessage) dc.sendMessageBinary(chunk.subarray(offset, offset + maxMessage));
      } catch (err) {
        callback(err as Error);
        return;
      }
      if (dc.bufferedAmount() > HIGH) waiting = () => callback();
      else callback();
    },
    final(callback) {
      // Let what is queued go out before the channel closes.
      const finish = () => {
        try {
          dc.close();
        } catch {
          // already closed
        }
        callback();
      };
      if (closed || dc.bufferedAmount() === 0) finish();
      else {
        const started = Date.now();
        const timer = setInterval(() => {
          if (closed || dc.bufferedAmount() === 0 || Date.now() - started > 2000) {
            clearInterval(timer);
            finish();
          }
        }, 20);
      }
    },
    destroy(err, callback) {
      closed = true;
      waiting = null;
      try {
        dc.close();
      } catch {
        // already closed
      }
      callback(err);
    },
  });
  dc.onMessage((message) => {
    if (typeof message === 'string') return;
    stream.push(Buffer.isBuffer(message) ? message : Buffer.from(message));
  });
  dc.onClosed(() => {
    closed = true;
    const resume = waiting;
    waiting = null;
    resume?.();
    stream.push(null);
    // What arrived before the close is still read first.
    setImmediate(() => stream.destroy());
  });
  dc.onError((error) => stream.destroy(new Error(`The connection to the Mac failed: ${error}`)));
  return stream;
}

/**
 * A relay WebSocket (after the server said "ready") as a Duplex. Binary frames
 * carry the bytes; WebSocket has no drain event, so writes poll the buffer.
 */
export function webSocketDuplex(ws: WebSocket): Duplex {
  ws.binaryType = 'arraybuffer';
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (ws.readyState !== WebSocket.OPEN) {
        callback(new Error('The relay connection closed.'));
        return;
      }
      // A Buffer is a Uint8Array view; the DOM typings want one over a plain ArrayBuffer.
      ws.send(chunk as unknown as Uint8Array<ArrayBuffer>);
      if (ws.bufferedAmount <= HIGH) {
        callback();
        return;
      }
      const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          clearInterval(timer);
          callback(new Error('The relay connection closed.'));
        } else if (ws.bufferedAmount <= LOW) {
          clearInterval(timer);
          callback();
        }
      }, 5);
    },
    final(callback) {
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
      callback();
    },
    destroy(err, callback) {
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
      callback(err);
    },
  });
  ws.addEventListener('message', (event) => {
    const data = event.data as unknown;
    if (typeof data === 'string') return;
    stream.push(Buffer.from(data as ArrayBuffer));
  });
  ws.addEventListener('close', () => {
    stream.push(null);
    setImmediate(() => stream.destroy());
  });
  ws.addEventListener('error', () => stream.destroy(new Error('The relay connection failed.')));
  return stream;
}
