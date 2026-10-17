/**
 * Windows data protection (DPAPI): what CapMac keeps for the developer, such as
 * a certificate's password or the sign-in to Apple's website, is usable only by
 * this Windows user on this PC.
 */
import { spawn } from 'node:child_process';
import { UserError } from '../errors.js';

const DPAPI = (action: 'Protect' | 'Unprotect') => "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; "
  + '$data=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); '
  + `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${action}($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`;

export async function dpapi(action: 'Protect' | 'Unprotect', data: Buffer): Promise<Buffer> {
  if (process.platform !== 'win32') throw new UserError('Saved signing passwords need Windows.');
  return new Promise((resolve, reject) => {
    // The secret goes through stdin, never the command line.
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DPAPI(action)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8').trim();
      if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(text)) reject(new UserError('Windows could not protect or read the saved signing password.'));
      else resolve(Buffer.from(text, 'base64'));
    });
    child.stdin.end(data.toString('base64'));
  });
}
