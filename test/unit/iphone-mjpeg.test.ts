import { describe, expect, it } from 'vitest';
import { MjpegParser } from '../../packages/core/src/engine/iphone/mjpeg.js';

/** A made-up JPEG: its start marker, some bytes, its end marker. */
const jpeg = (fill: number, size: number) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(size - 4, fill), Buffer.from([0xff, 0xd9])]);

/** WebDriverAgent's response body: one part per JPEG, as it writes them. */
const body = (...jpegs: Buffer[]) =>
  Buffer.concat(jpegs.flatMap((image) => [Buffer.from(`--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: ${image.length}\r\n\r\n`, 'latin1'), image, Buffer.from('\r\n\r\n')]));

describe('WebDriverAgent’s screen stream', () => {
  it('hands back each JPEG, in whatever pieces the body comes', () => {
    const images = [jpeg(1, 55_028), jpeg(2, 300), jpeg(3, 12_000)];
    const stream = body(...images);
    for (const piece of [1, 7, 64, 1500, 65_536, stream.length]) {
      const parser = new MjpegParser();
      const out: Buffer[] = [];
      for (let at = 0; at < stream.length; at += piece) out.push(...parser.push(stream.subarray(at, at + piece)));
      expect(out.map((image) => image.length)).toEqual([55_028, 300, 12_000]);
      expect(out.every((image, i) => image.equals(images[i]!))).toBe(true);
    }
  });

  it('reads the headers in any case and order, and skips a part that is not a JPEG', () => {
    const parser = new MjpegParser();
    const text = Buffer.from('not a picture', 'latin1');
    const out = parser.push(Buffer.concat([
      Buffer.from(`--b\r\ncontent-length: ${text.length}\r\nContent-Type: text/plain\r\n\r\n`, 'latin1'), text,
      Buffer.from(`\r\n--b\r\nCONTENT-LENGTH:300\r\nX-Other: 1\r\n\r\n`, 'latin1'), jpeg(9, 300),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(300);
  });

  it('drops what it can’t read and picks up at the next part', () => {
    const parser = new MjpegParser();
    expect(parser.push(Buffer.alloc(4096, 0x41))).toEqual([]);
    expect(parser.push(body(jpeg(5, 1000))).map((image) => image.length)).toEqual([1000]);
  });
});
