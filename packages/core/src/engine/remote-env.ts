import type { MacConnection } from './ssh.js';
import { shQuote } from './ssh.js';

export interface NodeCandidate {
  path: string;
  version: string;
}

export interface RemoteRuntime {
  home: string;
  user: string;
  os: string;
  arch: string;
  shell: string;
  candidates: NodeCandidate[];
  node: NodeCandidate | null;
}

export const MIN_NODE_MAJOR = 18;
export const RECOMMENDED_NODE_MAJOR = 20;

const DISCOVER_SCRIPT = String.raw`
echo "@@CAPMAC@@"
echo "home=$HOME"
echo "user=$(id -un)"
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "shell=$SHELL"
probe() {
  if [ -n "$1" ] && [ -x "$1" ]; then
    v=$("$1" --version 2>/dev/null) && echo "node=$1|$v"
  fi
}
probe "$(command -v node 2>/dev/null)"
for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" \
  "$HOME"/.nvm/versions/node/*/bin/node \
  "$HOME"/.fnm/node-versions/*/installation/bin/node \
  "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin/node \
  "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
  "$HOME"/.asdf/installs/nodejs/*/bin/node \
  "$HOME"/.local/share/mise/installs/node/*/bin/node \
  /usr/local/n/versions/node/*/bin/node \
  "$HOME"/.capmac/runtime/*/bin/node; do
  probe "$c"
done
login_shell="$SHELL"
[ -n "$login_shell" ] || login_shell=/bin/zsh
# Ask the user's own shell (interactive login reads .zshrc, where nvm & co live),
# but never wait more than ~6 seconds for slow or chatty shell setups.
tmp_dir="$TMPDIR"
[ -n "$tmp_dir" ] || tmp_dir=/tmp
ask_shell() {
  out="$tmp_dir/capmac-node-$$"
  ( "$login_shell" "$1" 'command -v node' </dev/null 2>/dev/null | tail -n 1 > "$out" ) &
  pid=$!
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 60 ]; do sleep 0.1; i=$((i+1)); done
  kill "$pid" 2>/dev/null
  cat "$out" 2>/dev/null
  rm -f "$out"
}
probe "$(ask_shell -ilc)"
probe "$(ask_shell -lc)"
echo "@@END@@"
`;

export function parseNodeVersion(version: string): [number, number, number] | null {
  const m = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a: string, b: string): number {
  const va = parseNodeVersion(a) ?? [0, 0, 0];
  const vb = parseNodeVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i]! - vb[i]!;
  return 0;
}

/** Picks the newest usable Node.js among those found on the Mac. */
export function pickNode(candidates: NodeCandidate[]): NodeCandidate | null {
  const usable = candidates.filter((c) => (parseNodeVersion(c.version)?.[0] ?? 0) >= MIN_NODE_MAJOR);
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) => compareVersions(b.version, a.version))[0]!;
}

export function parseDiscovery(stdout: string): RemoteRuntime {
  const body = stdout.slice(stdout.indexOf('@@CAPMAC@@'));
  const fields: Record<string, string> = {};
  const candidates: NodeCandidate[] = [];
  const seen = new Set<string>();
  for (const line of body.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'node') {
      const [p, v] = value.split('|');
      if (p && v && !seen.has(p)) {
        seen.add(p);
        candidates.push({ path: p, version: v });
      }
    } else {
      fields[key] = value;
    }
  }
  return {
    home: fields.home ?? '',
    user: fields.user ?? '',
    os: fields.os ?? '',
    arch: fields.arch ?? '',
    shell: fields.shell ?? '',
    candidates,
    node: pickNode(candidates),
  };
}

export async function discoverRuntime(conn: MacConnection): Promise<RemoteRuntime> {
  const result = await conn.runScript(DISCOVER_SCRIPT, { timeoutMs: 45_000 });
  if (!result.stdout.includes('@@CAPMAC@@')) {
    throw new Error(`Could not inspect the Mac's environment: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  }
  return parseDiscovery(result.stdout);
}

export interface NodeRelease {
  version: string;
  url: string;
  sha256: string;
}

/** Finds the latest LTS Node.js build for the Mac's architecture (looked up from Windows). */
export async function latestNodeLts(arch: string): Promise<NodeRelease> {
  const nodeArch = arch === 'arm64' ? 'arm64' : 'x64';
  const index = (await (await fetch('https://nodejs.org/dist/index.json')).json()) as Array<{ version: string; lts: string | false }>;
  const lts = index.find((r) => r.lts);
  if (!lts) throw new Error('Could not find a Node.js LTS release on nodejs.org.');
  const file = `node-${lts.version}-darwin-${nodeArch}.tar.gz`;
  const sums = await (await fetch(`https://nodejs.org/dist/${lts.version}/SHASUMS256.txt`)).text();
  const sha256 = sums.split('\n').find((line) => line.trim().endsWith(` ${file}`))?.split(/\s+/)[0];
  if (!sha256) throw new Error(`No checksum published for ${file}.`);
  return { version: lts.version, url: `https://nodejs.org/dist/${lts.version}/${file}`, sha256 };
}

/** Installs a private Node.js into ~/.capmac/runtime on the Mac (no sudo, no Homebrew). */
export async function installPortableNode(conn: MacConnection, home: string, release: NodeRelease): Promise<string> {
  const dir = `${home}/.capmac/runtime`;
  const name = release.url.slice(release.url.lastIndexOf('/') + 1).replace(/\.tar\.gz$/, '');
  const tmp = `${dir}/${name}.tar.gz`;
  const script = `set -e
mkdir -p ${shQuote(dir)}
curl -fsSL --retry 3 -o ${shQuote(tmp)} ${shQuote(release.url)}
actual=$(shasum -a 256 ${shQuote(tmp)} | cut -d ' ' -f 1)
if [ "$actual" != ${shQuote(release.sha256)} ]; then echo "checksum mismatch" >&2; rm -f ${shQuote(tmp)}; exit 3; fi
tar -xzf ${shQuote(tmp)} -C ${shQuote(dir)}
rm -f ${shQuote(tmp)}
${shQuote(`${dir}/${name}/bin/node`)} --version
`;
  const result = await conn.runScript(script, { timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(`Installing Node.js on the Mac failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return `${dir}/${name}/bin/node`;
}
