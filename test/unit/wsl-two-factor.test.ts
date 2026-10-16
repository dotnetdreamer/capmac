import { describe, expect, it, vi } from 'vitest';
import { silentContext, type Prompter } from '../../packages/core/src/engine/context.js';
import { CancelledError, UserError } from '../../packages/core/src/engine/errors.js';
import type { EngineEvent } from '../../packages/core/src/engine/events.js';
import { answerTwoFactorWithPrompter, verifyTwoFactor, type AppleResponse, type TwoFactorClient } from '../../packages/core/src/engine/wsl/apple-two-factor.js';

type Reply = { status: number; data?: unknown; headers?: Record<string, unknown> };
type Route = (config: { data?: unknown; headers: Record<string, string> }) => Reply;

/** A fake apple-utils request client: Apple's idmsa endpoints by "METHOD url"; HTTP errors reject like Axios. */
function fakeClient(routes: Record<string, Route | Route[]>) {
  const calls: { key: string; data?: unknown; headers: Record<string, string>; baseURL: string }[] = [];
  const handlers: { ok: (response: AppleResponse) => unknown; bad: (error: unknown) => unknown }[] = [];
  const client: TwoFactorClient = {
    request: vi.fn(async (config) => {
      const key = `${config.method.toUpperCase()} ${config.url}`;
      calls.push({ key, data: config.data, headers: config.headers, baseURL: config.baseURL });
      const route = routes[key];
      const handler = Array.isArray(route) ? route.shift() : route;
      if (!handler) throw new Error(`unexpected request ${key}`);
      const reply = handler(config);
      const response = { ...reply, config: { url: config.url, headers: config.headers } };
      if (reply.status >= 400) throw Object.assign(new Error(`Request failed with status code ${reply.status}`), { response });
      return response;
    }),
    interceptors: { response: { use: vi.fn((ok, bad) => { handlers.push({ ok, bad }); return 3; }), eject: vi.fn() } },
  };
  return { client, calls, handlers };
}

const HEADERS = { scnt: 'scnt-value', 'X-Apple-Id-Session-Id': 'session-id', 'X-Apple-Widget-Key': 'widget-key', Accept: 'application/json' };
const PHONE = { id: 2, numberWithDialCode: '+1 (•••) •••-••12' };
const ok = (): Reply => ({ status: 204 });

function prompter(codes: string[], choice = 0): Prompter {
  return {
    interactive: true,
    password: vi.fn(),
    confirm: vi.fn(),
    text: vi.fn(async () => codes.shift() ?? '000000'),
    choose: vi.fn(async <T>(request: { items: { value: T }[] }) => request.items[choice]!.value) as Prompter['choose'],
  };
}

function context(p: Prompter) {
  const events: EngineEvent[] = [];
  const ctx = silentContext(p);
  ctx.emit = (event) => events.push(event);
  return { ctx, events };
}

describe('Apple two-factor through CapMac’s prompts', () => {
  it('takes the code from the Apple devices, then trusts the session; the code goes to Apple only', async () => {
    const { client, calls } = fakeClient({
      'GET appleauth/auth': () => ({ status: 200, data: { trustedPhoneNumbers: [PHONE], securityCode: { length: 6 } } }),
      'POST appleauth/auth/verify/trusteddevice/securitycode': ok,
      'GET appleauth/auth/2sv/trust': ok,
    });
    const p = prompter(['123 456']);
    const { ctx, events } = context(p);
    await verifyTwoFactor(client, HEADERS, ctx);
    expect(calls.map((call) => call.key)).toEqual(['GET appleauth/auth', 'POST appleauth/auth/verify/trusteddevice/securitycode', 'GET appleauth/auth/2sv/trust']);
    expect(calls.every((call) => call.baseURL === 'https://idmsa.apple.com/' && call.headers.scnt === 'scnt-value' && call.headers['X-Apple-Id-Session-Id'] === 'session-id')).toBe(true);
    expect(calls[1]!.data).toEqual({ securityCode: { code: '123456' } });
    expect(p.text).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'apple-code', message: expect.stringContaining('6-digit code shown on your iPhone') }));
    expect(p.choose).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ label: expect.stringContaining('from my iPhone') }), expect.objectContaining({ label: expect.stringContaining('••12') })] }));
    expect(JSON.stringify(events)).not.toContain('123');
  });

  it('texts the code to a trusted phone when asked', async () => {
    const { client, calls } = fakeClient({
      'GET appleauth/auth': () => ({ status: 200, data: { trustedPhoneNumbers: [PHONE], securityCode: { length: 6 } } }),
      'PUT appleauth/auth/verify/phone': () => ({ status: 200, data: { phoneNumber: { id: 2 } } }),
      'POST appleauth/auth/verify/phone/securitycode': ok,
      'GET appleauth/auth/2sv/trust': ok,
    });
    const p = prompter(['654321'], 1);
    await verifyTwoFactor(client, HEADERS, context(p).ctx);
    expect(calls.map((call) => call.key)).toEqual(['GET appleauth/auth', 'PUT appleauth/auth/verify/phone', 'POST appleauth/auth/verify/phone/securitycode', 'GET appleauth/auth/2sv/trust']);
    expect(calls[1]!.data).toEqual({ phoneNumber: { id: 2 }, mode: 'sms' });
    expect(calls[2]!.data).toEqual({ securityCode: { code: '654321' }, phoneNumber: { id: 2 }, mode: 'sms' });
    expect(p.text).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('texted to +1 (•••) •••-••12') }));
  });

  it('with no trusted device and one phone, Apple has texted already: no question, no second text', async () => {
    const { client, calls } = fakeClient({
      'GET appleauth/auth': () => ({ status: 200, data: { noTrustedDevices: true, trustedPhoneNumbers: [PHONE], securityCode: { length: 6 } } }),
      'POST appleauth/auth/verify/phone/securitycode': ok,
      'GET appleauth/auth/2sv/trust': ok,
    });
    const p = prompter(['111111']);
    await verifyTwoFactor(client, HEADERS, context(p).ctx);
    expect(p.choose).not.toHaveBeenCalled();
    expect(calls.map((call) => call.key)).not.toContain('PUT appleauth/auth/verify/phone');
  });

  it('asks again after a wrong or mistyped code, and gives up after three wrong ones', async () => {
    const wrong = (): Reply => ({ status: 400, data: { serviceErrors: [{ code: '-21669', message: 'Incorrect verification code.' }] } });
    const { client } = fakeClient({
      'GET appleauth/auth': () => ({ status: 200, data: { trustedPhoneNumbers: [], securityCode: { length: 6 } } }),
      'POST appleauth/auth/verify/trusteddevice/securitycode': [wrong, ok],
      'GET appleauth/auth/2sv/trust': ok,
    });
    const p = prompter(['12345', '999999', '222222']);
    const { ctx, events } = context(p);
    await verifyTwoFactor(client, HEADERS, ctx);
    expect(p.text).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.type === 'log' && event.level === 'warn')).toHaveLength(2);

    const always = fakeClient({ 'GET appleauth/auth': () => ({ status: 200, data: { securityCode: { length: 6 } } }), 'POST appleauth/auth/verify/trusteddevice/securitycode': [wrong, wrong, wrong] });
    await expect(verifyTwoFactor(always.client, HEADERS, context(prompter(['1', '2', '3'].map((d) => d.repeat(6)))).ctx)).rejects.toThrow('Apple did not accept the verification code.');
  });

  it('stops clearly when Apple can’t ask for a code here', async () => {
    const tooMany = fakeClient({ 'GET appleauth/auth': () => ({ status: 200, data: { securityCode: { length: 6, tooManyCodesSent: true } } }) });
    await expect(verifyTwoFactor(tooMany.client, HEADERS, context(prompter([])).ctx)).rejects.toThrow('too many verification codes');
    const keyOnly = fakeClient({ 'GET appleauth/auth': () => ({ status: 200, data: { fsaChallenge: {} } }) });
    await expect(verifyTwoFactor(keyOnly.client, HEADERS, context(prompter([])).ctx)).rejects.toMatchObject({ hint: expect.stringContaining('security key') });
    const legacy = fakeClient({ 'GET appleauth/auth': () => ({ status: 200, data: { trustedDevices: [{ id: '1' }] } }) });
    await expect(verifyTwoFactor(legacy.client, HEADERS, context(prompter([])).ctx)).rejects.toThrow('older two-step verification');
  });

  it('a cancelled question cancels the sign-in', async () => {
    const { client } = fakeClient({ 'GET appleauth/auth': () => ({ status: 200, data: { trustedPhoneNumbers: [], securityCode: { length: 6 } } }) });
    const p = prompter([]);
    vi.mocked(p.text).mockRejectedValue(new CancelledError());
    await expect(verifyTwoFactor(client, HEADERS, context(p).ctx)).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('the sign-in interceptor', () => {
  const verifyFirst = (url = 'auth/signin/complete', headers: Record<string, unknown> = { scnt: 'scnt-value', 'x-apple-id-session-id': 'session-id' }) =>
    Object.assign(new Error('Request failed with status code 409'), { response: { status: 409, headers, data: { authType: 'hsa2' }, config: { url, headers: { 'X-Apple-Widget-Key': 'widget-key' } } } });

  it('answers Apple’s 409 for auth/signin/complete, so the sign-in goes on as if no code was needed', async () => {
    const { client, calls, handlers } = fakeClient({
      'GET appleauth/auth': () => ({ status: 200, data: { trustedPhoneNumbers: [], securityCode: { length: 6 } } }),
      'POST appleauth/auth/verify/trusteddevice/securitycode': ok,
      'GET appleauth/auth/2sv/trust': ok,
    });
    const stop = answerTwoFactorWithPrompter(client, context(prompter(['123456'])).ctx);
    const answered = await handlers[0]!.bad(verifyFirst()) as AppleResponse;
    expect(answered.status).toBe(200);
    expect(calls[0]!.headers).toMatchObject({ scnt: 'scnt-value', 'X-Apple-Id-Session-Id': 'session-id', 'X-Apple-Widget-Key': 'widget-key' });
    stop();
    expect(client.interceptors.response.eject).toHaveBeenCalledWith(3);
  });

  it('leaves every other response and error alone', async () => {
    const { client, handlers } = fakeClient({});
    answerTwoFactorWithPrompter(client, context(prompter([])).ctx);
    const plain = { status: 200, data: {}, config: { url: 'olympus/v1/session' } };
    expect(handlers[0]!.ok(plain)).toBe(plain);
    const other = verifyFirst('auth/signin/init');
    expect(() => handlers[0]!.bad(other)).toThrow(other);
    const network = new Error('socket hang up');
    expect(() => handlers[0]!.bad(network)).toThrow(network);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('refuses a 409 without Apple’s session headers', async () => {
    const { client, handlers } = fakeClient({});
    answerTwoFactorWithPrompter(client, context(prompter([])).ctx);
    await expect(handlers[0]!.bad(verifyFirst('auth/signin/complete', {})) as Promise<unknown>).rejects.toBeInstanceOf(UserError);
  });
});

describe('the real @expo/apple-utils', () => {
  it('signs in through its exported request client, which CapMac’s interceptor can answer', async () => {
    const actual = await vi.importActual<typeof import('@expo/apple-utils')>('@expo/apple-utils');
    const client = actual.getRequestClient();
    // The same client every time: the one the sign-in, its two-factor steps and the portal calls use.
    expect(actual.getRequestClient()).toBe(client);
    expect(typeof client.interceptors.response.use).toBe('function');
    expect(typeof client.interceptors.response.eject).toBe('function');
  });
});
