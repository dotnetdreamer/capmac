import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WdaControl } from '../../packages/core/src/engine/iphone/wda.js';

let server: http.Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

/** A WebDriverAgent stand-in that answers every request with 200 and keeps what it was sent. */
async function fakeWda(): Promise<{ port: number; requests: Array<{ method: string; url: string; body: unknown }> }> {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: text ? JSON.parse(text) : undefined });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: null, sessionId: 'S1' }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { port: (server!.address() as AddressInfo).port, requests };
}

/** A WdaControl as it is once its runner is up and its session open, on a 375×667-point iPhone 8. */
function control(port: number): WdaControl {
  const wda = new WdaControl({ udid: '808ccae4399545073522715663f015d9727366c4', name: 'iPhone', productVersion: '16.7.11', connection: 'usb' }, 'dev.capmac.wda.9xczl2pprh.xctrunner');
  Object.assign(wda as unknown as Record<string, unknown>, { port, session: 'S1', size: { width: 375, height: 667 } });
  return wda;
}

const finger = (actions: unknown[]) => ({ actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }] });

describe('touch through WebDriverAgent', () => {
  it('sends taps, holds and drags as one finger’s W3C actions, in the iPhone’s points', async () => {
    const wda = await fakeWda();
    const touch = control(wda.port);
    await touch.tap(0.5, 0.25);
    await touch.hold(0.1, 0.9, 1.2);
    // A fast flick from right to left, as the pane measured it (in seconds).
    await touch.drag(0.85, 0.5, 0.15, 0.5, 0.12);
    expect(wda.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /session/S1/actions', 'POST /session/S1/actions', 'POST /session/S1/actions']);
    expect(wda.requests[0]!.body).toEqual(finger([
      { type: 'pointerMove', duration: 0, x: 188, y: 167 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 40 },
      { type: 'pointerUp', button: 0 },
    ]));
    expect(wda.requests[1]!.body).toEqual(finger([
      { type: 'pointerMove', duration: 0, x: 38, y: 600 },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 1200 },
      { type: 'pointerUp', button: 0 },
    ]));
    expect(wda.requests[2]!.body).toEqual(finger([
      { type: 'pointerMove', duration: 0, x: 319, y: 334 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: 120, x: 56, y: 334 },
      { type: 'pointerUp', button: 0 },
    ]));
  });

  it('keeps gestures within what XCTest plays well', async () => {
    const wda = await fakeWda();
    const touch = control(wda.port);
    await touch.drag(0, 0, 1, 1, 9);
    await touch.hold(0.5, 0.5, 60);
    const moves = (i: number) => (wda.requests[i]!.body as { actions: Array<{ actions: Array<{ type: string; duration?: number }> }> }).actions[0]!.actions;
    expect(moves(0)[2]).toMatchObject({ type: 'pointerMove', duration: 1500 });
    expect(moves(1)[2]).toEqual({ type: 'pause', duration: 10_000 });
  });
});
