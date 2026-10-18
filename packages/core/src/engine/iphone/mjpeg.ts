/**
 * WebDriverAgent's screen stream (MJPEG over HTTP, multipart/x-mixed-replace): each part is one
 * JPEG with its Content-Length. MjpegParser takes the response body in whatever chunks it comes
 * and hands back whole JPEGs.
 *
 * Pure (no sockets), so it is unit-tested with made-up bodies.
 */

/** A part's headers end within this many bytes (WebDriverAgent sends about 70). */
const HEADERS_MAX = 1024;
/** Bigger than any screen's JPEG: a length past this is a broken stream. */
const JPEG_MAX = 32 * 1024 * 1024;

export class MjpegParser {
  private buffer: Buffer = Buffer.alloc(0);
  /** Bytes of the JPEG being read, once its headers were read. */
  private need = 0;

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const jpegs: Buffer[] = [];
    for (;;) {
      if (this.need) {
        if (this.buffer.length < this.need) break;
        const jpeg = this.buffer.subarray(0, this.need);
        this.buffer = this.buffer.subarray(this.need);
        this.need = 0;
        // A part that isn't a JPEG (it starts with FFD8) is skipped.
        if (jpeg[0] === 0xff && jpeg[1] === 0xd8) jpegs.push(jpeg);
        continue;
      }
      // The boundary and the part's headers, up to the blank line after its Content-Length.
      const head = this.buffer.toString('latin1', 0, Math.min(this.buffer.length, HEADERS_MAX));
      const length = /content-length:[ \t]*(\d+)/i.exec(head);
      const end = length ? head.indexOf('\r\n\r\n', length.index) : -1;
      if (!length || end < 0) {
        // Not there yet; with nothing like headers in the first kilobyte, the stream is broken.
        if (this.buffer.length >= HEADERS_MAX) this.buffer = Buffer.alloc(0);
        break;
      }
      const size = Number(length[1]);
      this.buffer = this.buffer.subarray(end + 4);
      if (size > 0 && size <= JPEG_MAX) this.need = size;
    }
    return jpegs;
  }
}
