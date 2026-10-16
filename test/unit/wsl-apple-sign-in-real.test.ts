/**
 * The real @expo/apple-utils sign-in, with Apple faked behind its request
 * client's adapter. Its own terminal prompts for the two-factor code live in
 * a module it does not export, so they can't be replaced; CapMac answers the
 * code request on that client instead. Here that must take every question
 * (email, password, code, team) through CapMac's prompter, with no terminal.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { silentContext, type Prompter } from '../../packages/core/src/engine/context.js';
import { loginAppleAccount } from '../../packages/core/src/engine/wsl/apple-account.js';

interface AdapterConfig { method?: string; url?: string; baseURL?: string; headers?: Record<string, string>; data?: unknown }
type Reply = { status: number; data?: unknown; headers?: Record<string, string | string[]> };
type Expo = typeof import('@expo/apple-utils');
interface Client { defaults: { adapter?: unknown }; interceptors: { response: { handlers: unknown[] } } }

const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.unstubAllEnvs();
});

const fullUrl = (config: AdapterConfig) => (/^https?:/.test(config.url ?? '') ? config.url! : `${(config.baseURL ?? '').replace(/\/+$/, '')}/${(config.url ?? '').replace(/^\/+/, '')}`);

/** Apple, faked at the adapter of apple-utils' own request client: every request is recorded, unknown ones get a 404. */
async function fakeApple(routes: Array<[string, (config: AdapterConfig) => Reply]>) {
  const imported = (await import('@expo/apple-utils')) as unknown as Expo & { default?: Expo };
  const client = (imported.default ?? imported).getRequestClient() as unknown as Client;
  const requests: { key: string; data: unknown }[] = [];
  const previous = client.defaults.adapter;
  client.defaults.adapter = async (config: AdapterConfig) => {
    const key = `${(config.method ?? 'get').toUpperCase()} ${fullUrl(config).split('?')[0]}`;
    requests.push({ key, data: typeof config.data === 'string' ? JSON.parse(config.data || 'null') : config.data });
    const route = routes.find(([name]) => name === key);
    const reply = route ? route[1](config) : { status: 404, data: { error: `no fake for ${key}` } };
    return { data: reply.data ?? '', status: reply.status, statusText: String(reply.status), headers: reply.headers ?? {}, config, request: {} };
  };
  restore = () => { client.defaults.adapter = previous; };
  return { client, requests };
}

describe('the real apple-utils sign-in, with two-factor', () => {
  it('asks the email, password, code and team through CapMac’s prompter, with no terminal, and leaves no interceptor behind', async () => {
    vi.stubEnv('EXPO_APP_STORE_AUTH_SERVICE_KEY', 'fake-widget-key');
    vi.stubEnv('EXPO_APP_STORE_DEBUG', 'false');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const b64 = (n: number) => randomBytes(n).toString('base64');
    const IDMSA = 'https://idmsa.apple.com/appleauth/auth';
    const { client, requests } = await fakeApple([
      [`GET ${IDMSA}/signin`, () => ({ status: 200, data: '<html></html>' })],
      [`POST ${IDMSA}/signin/init`, () => ({ status: 200, data: { iteration: 1000, salt: b64(16), protocol: 's2k', b: b64(256), c: 'challenge' } })],
      // "Verify first": apple-utils would now ask for the code in the terminal.
      [`POST ${IDMSA}/signin/complete`, () => ({ status: 409, data: { authType: 'hsa2' }, headers: { scnt: 'scnt-1', 'x-apple-id-session-id': 'session-1' } })],
      [`GET ${IDMSA}`, () => ({ status: 200, data: { trustedPhoneNumbers: [{ id: 1, numberWithDialCode: '+1 (•••) •••-••12' }], securityCode: { length: 6 } } })],
      [`POST ${IDMSA}/verify/trusteddevice/securitycode`, () => ({ status: 204 })],
      [`GET ${IDMSA}/2sv/trust`, () => ({ status: 204 })],
      ['POST https://developer.apple.com/services-account/QH65B2/account/listTeams.action', () => ({ status: 200, data: { resultCode: 0, teams: [{ teamId: 'ABCDE12345', name: 'Example Team', type: 'Company/Organization', status: 'active' }, { teamId: 'FGHIJ67890', name: 'Other Team', type: 'Individual', status: 'active' }] } })],
      ['GET https://appstoreconnect.apple.com/olympus/v1/session', () => ({ status: 200, data: { provider: { providerId: 1, name: 'Example Team' }, availableProviders: [{ providerId: 1, name: 'Example Team' }], user: { emailAddress: 'developer@example.test' } } })],
    ]);
    const interceptorsBefore = client.interceptors.response.handlers.filter(Boolean).length;
    const prompter: Prompter = {
      interactive: true,
      text: vi.fn(async (request) => (request.purpose === 'apple-email' ? 'developer@example.test' : '246 810')),
      password: vi.fn(async () => 'secret-password'),
      choose: vi.fn(async <T>(request: { items: { value: T }[] }) => request.items[0]!.value) as Prompter['choose'],
      confirm: vi.fn(async () => true),
    };
    const session = await loginAppleAccount(silentContext(prompter));

    expect(session.team).toEqual({ id: 'ABCDE12345', name: 'Example Team' });
    expect(requests.map((request) => request.key)).toEqual([
      `GET ${IDMSA}/signin`, `POST ${IDMSA}/signin/init`, `POST ${IDMSA}/signin/complete`,
      `GET ${IDMSA}`, `POST ${IDMSA}/verify/trusteddevice/securitycode`, `GET ${IDMSA}/2sv/trust`,
      'POST https://developer.apple.com/services-account/QH65B2/account/listTeams.action', 'GET https://appstoreconnect.apple.com/olympus/v1/session',
    ]);
    expect(requests[4]!.data).toEqual({ securityCode: { code: '246810' } });
    expect(vi.mocked(prompter.text).mock.calls.map(([request]) => request.purpose)).toEqual(['apple-email', 'apple-code']);
    expect(prompter.password).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'apple' }));
    expect(vi.mocked(prompter.choose).mock.calls.map(([request]) => request.message)).toEqual(['Apple sent a verification code to your Apple devices', 'Choose your Apple developer team:']);
    expect(JSON.stringify(session)).not.toMatch(/secret-password|246810|scnt-1|session-1/);
    expect(client.interceptors.response.handlers.filter(Boolean)).toHaveLength(interceptorsBefore);
    session.close();
  });

  it('in a terminal, its sign-in spinner prints plain lines instead of redrawing over the code question', async () => {
    vi.stubEnv('EXPO_APP_STORE_AUTH_SERVICE_KEY', 'fake-widget-key');
    vi.stubEnv('EXPO_APP_STORE_DEBUG', 'false');
    vi.stubEnv('TERM', 'xterm-256color');
    delete process.env.CI;
    const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    const written: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write);
    try {
      const b64 = (n: number) => randomBytes(n).toString('base64');
      const IDMSA = 'https://idmsa.apple.com/appleauth/auth';
      await fakeApple([
        [`GET ${IDMSA}/signin`, () => ({ status: 200, data: '' })],
        [`POST ${IDMSA}/signin/init`, () => ({ status: 200, data: { iteration: 1000, salt: b64(16), protocol: 's2k', b: b64(256), c: 'challenge' } })],
        [`POST ${IDMSA}/signin/complete`, () => ({ status: 409, data: {}, headers: { scnt: 'scnt-1', 'x-apple-id-session-id': 'session-1' } })],
        [`GET ${IDMSA}`, () => ({ status: 200, data: { trustedPhoneNumbers: [], securityCode: { length: 6 } } })],
        [`POST ${IDMSA}/verify/trusteddevice/securitycode`, () => ({ status: 204 })],
        [`GET ${IDMSA}/2sv/trust`, () => ({ status: 204 })],
        ['POST https://developer.apple.com/services-account/QH65B2/account/listTeams.action', () => ({ status: 200, data: { resultCode: 0, teams: [{ teamId: 'ABCDE12345', name: 'Example Team', type: 'Company/Organization', status: 'active' }] } })],
        ['GET https://appstoreconnect.apple.com/olympus/v1/session', () => ({ status: 200, data: { provider: { providerId: 1, name: 'Example Team' }, availableProviders: [{ providerId: 1, name: 'Example Team' }], user: { emailAddress: 'developer@example.test' } } })],
      ]);
      let duringQuestion = '';
      const prompter: Prompter = {
        interactive: true,
        text: vi.fn(async (request) => {
          if (request.purpose !== 'apple-code') return 'developer@example.test';
          // A spinner left running would redraw several times while someone types the code.
          await new Promise((resolve) => setTimeout(resolve, 300));
          duringQuestion = written.join('');
          return '246810';
        }),
        password: vi.fn(async () => 'secret-password'),
        choose: vi.fn(async <T>(request: { items: { value: T }[] }) => request.items[0]!.value) as Prompter['choose'],
        confirm: vi.fn(async () => true),
      };
      await loginAppleAccount(silentContext(prompter));
      expect(duringQuestion).toContain('- Logging in...');
      // No hidden cursor, no carriage-return redraws: the spinner never animated.
      expect(written.join('')).not.toMatch(/\u001B\[\?25l|\r/);
      expect(process.stderr.isTTY).toBe(true);
    } finally {
      write.mockRestore();
      if (stderrTTY) Object.defineProperty(process.stderr, 'isTTY', stderrTTY); else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
  });
});
