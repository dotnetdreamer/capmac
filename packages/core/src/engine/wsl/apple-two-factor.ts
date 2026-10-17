/**
 * Apple's two-factor step, asked through CapMac's own prompts: the terminal,
 * or CapMac Studio's dialogs.
 *
 * @expo/apple-utils asks for the code with terminal prompts that live in a
 * module it does not export, so they can't be replaced. Its sign-in skips them
 * when `auth/signin/complete` succeeds, and all of it goes through the request
 * client it does export. So, while signing in, a response interceptor on that
 * client takes Apple's "verify first" answer (HTTP 409), does the same
 * idmsa.apple.com steps apple-utils would, then hands the sign-in a success.
 * Codes go to Apple only: they are never logged, emitted or saved.
 */
import { log, throwIfAborted, type EngineContext } from '../context.js';
import { UserError } from '../errors.js';

const IDMSA = 'https://idmsa.apple.com/';
const SIGN_IN_COMPLETE = /(?:^|\/)auth\/signin\/complete$/;
/** Wrong or mistyped codes before giving up; Apple locks the account after a few more. */
const MAX_ATTEMPTS = 3;

export interface AppleResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, unknown>;
  data?: unknown;
  config?: { url?: string; headers?: Record<string, unknown> };
}

/** The part of apple-utils' Axios client this uses. */
export interface TwoFactorClient {
  request(config: { method: 'get' | 'put' | 'post'; baseURL: string; url: string; headers: Record<string, string>; data?: unknown }): Promise<AppleResponse>;
  interceptors: { response: { use(onFulfilled: (response: AppleResponse) => unknown, onRejected: (error: unknown) => unknown): number; eject(id: number): void } };
}

interface TrustedPhone { id: number; numberWithDialCode: string }
interface AuthOptions {
  trustedDevices?: unknown[];
  trustedPhoneNumbers?: unknown[];
  noTrustedDevices?: boolean;
  securityCode?: { length?: number; tooManyCodesSent?: boolean };
}

function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== name) continue;
    const text = Array.isArray(value) ? value[0] : value;
    return typeof text === 'string' && text && !/[\r\n\0]/.test(text) ? text : undefined;
  }
  return undefined;
}

/** Apple's own error text is safe to show: it never holds a cookie, token or code. */
function appleMessages(data: unknown): string[] {
  const value = data as { serviceErrors?: unknown; service_errors?: unknown } | undefined;
  const errors = [value?.serviceErrors, value?.service_errors].find(Array.isArray) as Array<{ message?: unknown; code?: unknown }> | undefined;
  return (errors ?? []).map((error) => (typeof error?.message === 'string' ? error.message : typeof error?.code === 'string' ? error.code : ''))
    .map((text) => text.replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 200)).filter(Boolean);
}

function wrongCode(response: { status: number; data: unknown }): boolean {
  const errors = (response.data as { serviceErrors?: Array<{ code?: unknown }> } | undefined)?.serviceErrors;
  return (Array.isArray(errors) && errors.some((error) => error?.code === '-21669')) || appleMessages(response.data).some((text) => /code/i.test(text));
}

function failure(response: { status: number; data: unknown }, message: string): UserError {
  return new UserError(message, 'Try again in a few minutes, or sign in at appleid.apple.com to check your account.', [`HTTP ${response.status}`, ...appleMessages(response.data)]);
}

async function idmsa(client: TwoFactorClient, method: 'get' | 'put' | 'post', url: string, headers: Record<string, string>, data?: unknown, signal?: AbortSignal): Promise<{ status: number; data: unknown }> {
  throwIfAborted(signal);
  try {
    const response = await client.request({ method, baseURL: IDMSA, url, headers, ...(data === undefined ? {} : { data }) });
    return { status: response.status, data: response.data };
  } catch (error) {
    // Axios rejects an HTTP error with its response; that answer is what is needed here.
    const response = (error as { response?: AppleResponse } | undefined)?.response;
    if (response && typeof response.status === 'number') return { status: response.status, data: response.data };
    throw error;
  }
}

function trustedPhones(value: unknown): TrustedPhone[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const phone = item as { id?: unknown; numberWithDialCode?: unknown } | null;
    if (!phone || typeof phone.id !== 'number' || !Number.isSafeInteger(phone.id)) return [];
    // Apple sends it masked ("+1 (•••) •••-••12").
    const number = typeof phone.numberWithDialCode === 'string' ? phone.numberWithDialCode.replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, 40) : '';
    return [{ id: phone.id, numberWithDialCode: number || 'your trusted phone number' }];
  });
}

async function askCode(ctx: EngineContext, length: number, phone: TrustedPhone | undefined, signal?: AbortSignal): Promise<string> {
  const message = phone ? `Enter the ${length}-digit code Apple texted to ${phone.numberWithDialCode}` : `Enter the ${length}-digit code shown on your iPhone, iPad or Mac`;
  for (let attempt = 1; ; attempt++) {
    throwIfAborted(signal);
    const code = (await ctx.prompter.text({ purpose: 'apple-code', message, placeholder: '0'.repeat(length) })).replace(/[\s-]/g, '');
    if (new RegExp(`^\\d{${length}}$`).test(code)) return code;
    if (attempt >= MAX_ATTEMPTS) throw new UserError(`Apple’s verification code has ${length} digits.`, 'Sign in again to get a new code.');
    log(ctx, 'warn', `Apple’s code has ${length} digits. Type just the numbers.`);
  }
}

/** Apple's verification for a sign-in that answered 409: asks for the code and tells Apple to trust the session. */
export async function verifyTwoFactor(client: TwoFactorClient, headers: Record<string, string>, ctx: EngineContext, signal?: AbortSignal): Promise<void> {
  const auth = await idmsa(client, 'get', 'appleauth/auth', headers, undefined, signal);
  if (auth.status >= 400) throw failure(auth, 'Apple did not start the two-factor check.');
  const options = (auth.data ?? {}) as AuthOptions;
  if (options.securityCode?.tooManyCodesSent) throw new UserError('Apple has sent too many verification codes.', 'Wait a while, then sign in again.');
  // Apple retired this older scheme; accounts that still use it can switch on Apple's site.
  if (Array.isArray(options.trustedDevices) && options.trustedDevices.length) throw new UserError('This Apple Account uses the older two-step verification.', 'Turn on two-factor authentication at appleid.apple.com, then sign in again.');
  const phones = trustedPhones(options.trustedPhoneNumbers);
  if (!options.securityCode || (options.noTrustedDevices && !phones.length)) {
    throw new UserError('Apple asked for a check CapMac can’t do.', 'If your only second factor is a security key, add a trusted phone number to your Apple Account, then sign in again.');
  }
  const length = Number.isInteger(options.securityCode.length) && options.securityCode.length! >= 4 && options.securityCode.length! <= 8 ? options.securityCode.length! : 6;
  const sendText = async (phone: TrustedPhone) => {
    const sent = await idmsa(client, 'put', 'appleauth/auth/verify/phone', { ...headers, 'Content-Type': 'application/json' }, { phoneNumber: { id: phone.id }, mode: 'sms' }, signal);
    if (sent.status >= 400) throw failure(sent, 'Apple could not send a text message.');
  };
  let phone: TrustedPhone | undefined;
  if (options.noTrustedDevices) {
    // With one trusted phone and no devices, Apple has texted the code already.
    phone = phones.length === 1 ? phones[0]! : await ctx.prompter.choose({ message: 'Where should Apple text your verification code?', items: phones.map((item) => ({ label: item.numberWithDialCode, value: item })) });
    if (phones.length > 1) await sendText(phone);
  } else if (phones.length) {
    // Apple has sent the code to the account's devices already; a text message is the other way.
    const choice = await ctx.prompter.choose<{ phone?: TrustedPhone }>({
      message: 'Apple sent a verification code to your Apple devices',
      items: [{ label: 'Enter the code from my iPhone, iPad or Mac', value: {} }, ...phones.map((item) => ({ label: `Text a code to ${item.numberWithDialCode} instead`, value: { phone: item } }))],
    });
    phone = choice.phone;
    if (phone) await sendText(phone);
  }
  for (let attempt = 1; ; attempt++) {
    const code = await askCode(ctx, length, phone, signal);
    const verified = phone
      ? await idmsa(client, 'post', 'appleauth/auth/verify/phone/securitycode', { ...headers, 'Content-Type': 'application/json' }, { securityCode: { code }, phoneNumber: { id: phone.id }, mode: 'sms' }, signal)
      : await idmsa(client, 'post', 'appleauth/auth/verify/trusteddevice/securitycode', { ...headers, 'Content-Type': 'application/json' }, { securityCode: { code } }, signal);
    if (verified.status < 400 && !appleMessages(verified.data).length) break;
    if (!wrongCode(verified)) throw failure(verified, 'Apple did not accept the verification.');
    if (attempt >= MAX_ATTEMPTS) throw new UserError('Apple did not accept the verification code.', 'Sign in again to get a new code.');
    log(ctx, 'warn', 'That code didn’t work. Check it and try again.');
  }
  // Like Xcode's sign-in: the verified session is trusted, so the developer portal accepts it.
  const trusted = await idmsa(client, 'get', 'appleauth/auth/2sv/trust', headers, undefined, signal);
  if (trusted.status >= 400) throw failure(trusted, 'Apple did not finish the sign-in.');
}

/**
 * Answers the sign-in's two-factor request through `ctx.prompter` until the
 * returned function is called. Only `auth/signin/complete` answering 409 is
 * touched; every other response passes through unchanged.
 */
export function answerTwoFactorWithPrompter(client: TwoFactorClient, ctx: EngineContext, signal?: AbortSignal): () => void {
  const isVerifyRequest = (response: AppleResponse | undefined): response is AppleResponse =>
    response?.status === 409 && SIGN_IN_COMPLETE.test(String(response.config?.url ?? '').split('?')[0]!);
  const answer = async (response: AppleResponse): Promise<AppleResponse> => {
    const scnt = header(response.headers, 'scnt');
    const session = header(response.headers, 'x-apple-id-session-id');
    const widget = header(response.config?.headers, 'x-apple-widget-key');
    if (!scnt || !session || !widget) throw new UserError('Apple asked for a verification code but did not say how.', 'Try again in a few minutes.');
    await verifyTwoFactor(client, { scnt, 'X-Apple-Id-Session-Id': session, 'X-Apple-Widget-Key': widget, Accept: 'application/json' }, ctx, signal);
    return { ...response, status: 200, statusText: 'OK', data: {} };
  };
  const id = client.interceptors.response.use(
    (response) => (isVerifyRequest(response) ? answer(response) : response),
    (error) => {
      const response = (error as { response?: AppleResponse } | undefined)?.response;
      if (isVerifyRequest(response)) return answer(response);
      throw error;
    },
  );
  return () => client.interceptors.response.eject(id);
}
