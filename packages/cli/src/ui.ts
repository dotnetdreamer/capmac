import readline from 'node:readline';
import { formatDuration } from '@capmac/core/engine';
import picocolors from 'picocolors';

export { formatBytes, formatDuration, plural } from '@capmac/core/engine';

const isTTY = Boolean(process.stdout.isTTY) && process.env.CAPMAC_NO_TTY !== '1';
// Colour only in a terminal (picocolors also colours pipes on Windows), so AI agents,
// scripts and log files get plain text. NO_COLOR and FORCE_COLOR still win.
const pc = picocolors.createColors(!process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR) || isTTY));
const ascii = process.env.CAPMAC_ASCII === '1';
const SPINNER = ascii ? ['-', '\\', '|', '/'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const sym = {
  ok: pc.green(ascii ? '+' : '✔'),
  fail: pc.red(ascii ? 'x' : '✖'),
  warn: pc.yellow(ascii ? '!' : '▲'),
  info: pc.cyan(ascii ? 'i' : '●'),
  arrow: pc.dim(ascii ? '>' : '›'),
  dot: pc.dim('·'),
};

let verbose = process.env.CAPMAC_VERBOSE === '1';
export function setVerbose(value: boolean): void {
  verbose = value;
}
export function isVerbose(): boolean {
  return verbose;
}

function truncate(text: string, width: number): string {
  const clean = text.replace(/\s+/g, ' ');
  return clean.length > width ? `${clean.slice(0, Math.max(0, width - 1))}…` : clean;
}

/** One live status line at a time; anything else printed goes above it. */
class StatusLine {
  private text = '';
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private visible = false;

  set(text: string): void {
    this.text = text;
    if (!isTTY) return;
    if (!this.timer) {
      this.timer = setInterval(() => this.render(), 80);
      this.timer.unref();
    }
    this.render();
  }

  clear(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.erase();
    this.text = '';
  }

  /** Print a full line without fighting the spinner. */
  print(line: string, stream: NodeJS.WriteStream = process.stdout): void {
    this.erase();
    stream.write(`${line}\n`);
    if (this.text && isTTY) this.render();
  }

  private erase(): void {
    if (this.visible && isTTY) {
      process.stdout.write('\r\x1b[2K');
      this.visible = false;
    }
  }

  private render(): void {
    if (!this.text) return;
    const width = Math.max(20, (process.stdout.columns || 100) - 4);
    const spinner = pc.cyan(SPINNER[this.frame++ % SPINNER.length]!);
    process.stdout.write(`\r\x1b[2K${spinner} ${truncate(this.text, width)}`);
    this.visible = true;
  }
}

const status = new StatusLine();

export const log = {
  line(text = ''): void {
    status.print(text);
  },
  info(text: string): void {
    status.print(`${sym.info} ${text}`);
  },
  success(text: string): void {
    status.print(`${sym.ok} ${text}`);
  },
  warn(text: string): void {
    status.print(`${sym.warn} ${pc.yellow(text)}`);
  },
  error(text: string): void {
    status.print(`${sym.fail} ${pc.red(text)}`, process.stderr);
  },
  dim(text: string): void {
    status.print(pc.dim(text));
  },
  debug(text: string): void {
    if (verbose) status.print(pc.dim(`  ${text}`));
  },
  raw(text: string): void {
    status.print(text);
  },
};

export interface Step {
  update(text: string): void;
  succeed(detail?: string): void;
  fail(detail?: string): void;
  skip(detail?: string): void;
  readonly elapsed: number;
}

let activeStep: { title: string } | null = null;

/** A titled, timed task with a spinner (TTY) or start/end lines (CI). */
export function step(title: string): Step {
  const started = Date.now();
  activeStep = { title };
  if (isTTY) status.set(title);
  else process.stdout.write(`${sym.arrow} ${title}\n`);
  let done = false;
  const finish = (symbol: string, detail?: string) => {
    if (done) return;
    done = true;
    activeStep = null;
    status.clear();
    const time = pc.dim(formatDuration(Date.now() - started));
    process.stdout.write(`${symbol} ${title}${detail ? pc.dim(` ${sym.dot} ${detail}`) : ''} ${time}\n`);
  };
  return {
    update(text: string) {
      if (done) return;
      if (isTTY) status.set(`${title} ${pc.dim(`${sym.arrow} ${text}`)}`);
    },
    succeed: (detail) => finish(sym.ok, detail),
    fail: (detail) => finish(sym.fail, detail),
    skip: (detail) => finish(pc.dim(ascii ? '-' : '○'), detail),
    get elapsed() {
      return Date.now() - started;
    },
  };
}

export async function withStep<T>(title: string, fn: (s: Step) => Promise<T>, detail?: (value: T) => string | undefined): Promise<T> {
  const s = step(title);
  try {
    const value = await fn(s);
    s.succeed(detail?.(value));
    return value;
  } catch (err) {
    s.fail();
    throw err;
  }
}

export function clearStatus(): void {
  status.clear();
  void activeStep;
}

export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && process.env.CI !== 'true';
}

let prompting = 0;
let keyMode = false;

/** True while a question or password prompt owns the keyboard. */
export function isPrompting(): boolean {
  return prompting > 0;
}

/** Remembers that single-key shortcuts are active, so prompts restore raw mode afterwards. */
export function setKeyMode(active: boolean): void {
  keyMode = active;
}

function restoreKeyMode(): void {
  if (keyMode && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
}

export function ask(question: string, defaultValue?: string): Promise<string> {
  clearStatus();
  prompting += 1;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? pc.dim(` (${defaultValue})`) : '';
  return new Promise((resolve) => {
    rl.question(`${pc.cyan('?')} ${question}${suffix} `, (answer) => {
      rl.close();
      prompting -= 1;
      restoreKeyMode();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/** Like `ask`, but `signal` takes the question back (it was answered elsewhere): resolves with null then. */
export function askUnless(question: string, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null);
  clearStatus();
  prompting += 1;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      rl.close();
      prompting -= 1;
      restoreKeyMode();
      resolve(value);
    };
    const onAbort = () => {
      process.stdout.write('\n');
      finish(null);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Ctrl+C still stops the command (readline would swallow it).
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      finish(null);
      process.emit('SIGINT');
    });
    rl.question(`${pc.cyan('?')} ${question} `, (answer) => finish(answer.trim()));
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = (await ask(`${question} ${pc.dim(defaultYes ? '[Y/n]' : '[y/N]')}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** Reads a secret without echoing it. */
export function password(question: string): Promise<string> {
  clearStatus();
  prompting += 1;
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(`${pc.cyan('?')} ${question} `);
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin });
      rl.once('line', (line) => {
        rl.close();
        process.stdout.write('\n');
        resolve(line);
      });
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  }).finally(() => {
    prompting -= 1;
    restoreKeyMode();
  });
}

export async function select<T>(question: string, items: Array<{ label: string; value: T; hint?: string }>): Promise<T> {
  log.line(`${pc.cyan('?')} ${question}`);
  items.forEach((item, i) => log.line(`  ${pc.cyan(String(i + 1).padStart(2))}) ${item.label}${item.hint ? pc.dim(`  ${item.hint}`) : ''}`));
  for (;;) {
    const answer = await ask(`Choose 1-${items.length}:`, '1');
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && items[index]) return items[index]!.value;
    log.warn(`Please enter a number between 1 and ${items.length}.`);
  }
}

/** Several choices by number ("1,3", "all"); Enter keeps the pre-selected ones. */
export async function multiSelect<T>(question: string, items: Array<{ label: string; value: T; hint?: string; selected?: boolean }>): Promise<T[]> {
  log.line(`${pc.cyan('?')} ${question}`);
  items.forEach((item, i) => log.line(`  ${pc.cyan(String(i + 1).padStart(2))}) ${item.selected ? pc.green('●') : pc.dim('○')} ${item.label}${item.hint ? pc.dim(`  ${item.hint}`) : ''}`));
  const preselected = items.map((item, i) => (item.selected ? String(i + 1) : null)).filter(Boolean).join(',');
  for (;;) {
    const answer = (await ask('Numbers separated by commas, or "all":', preselected || undefined)).toLowerCase();
    if (answer === 'all') return items.map((item) => item.value);
    const picked = answer.split(/[\s,]+/).filter(Boolean).map((n) => Number(n) - 1);
    if (picked.length && picked.every((i) => Number.isInteger(i) && items[i])) return [...new Set(picked)].map((i) => items[i]!.value);
    log.warn(`Please enter numbers between 1 and ${items.length}, separated by commas.`);
  }
}

export { pc };
