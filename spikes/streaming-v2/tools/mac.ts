// Runs scripts on, and copies files to, the paired Mac over capmac's own SSH
// connection (same key, host key pinned). For exploring the Mac side.
//
//   npx esbuild spikes/streaming-v2/tools/mac.ts --bundle --platform=node --format=cjs \
//     --external:cpu-features --external:*.node --outfile=spikes/streaming-v2/out/mac.cjs
//   node spikes/streaming-v2/out/mac.cjs sh 'xcrun simctl list devices booted'
//   node spikes/streaming-v2/out/mac.cjs sh -f script.sh
//   node spikes/streaming-v2/out/mac.cjs put spikes/streaming-v2/tools/introspect.m .capmac/spike/introspect.m
import { readFileSync } from 'node:fs';
import { MacSession } from '../../../packages/core/src/engine/session.js';

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const session = await MacSession.open({});
  try {
    if (cmd === 'sh') {
      const script = args[0] === '-f' ? readFileSync(args[1]!, 'utf8') : args.join(' ');
      const r = await session.conn.runScript(script, { timeoutMs: 15 * 60_000 });
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      process.exitCode = r.code ?? 1;
    } else if (cmd === 'put') {
      const [local, remote] = args as [string, string];
      // Remote paths are relative to the Mac user's home folder.
      const r = await session.conn.pipeTo(`mkdir -p "$(dirname '${remote}')" && cat > '${remote}'`, readFileSync(local));
      if (r.code !== 0) throw new Error(r.stderr);
      console.log(`copied ${local} to ~/${remote}`);
    } else {
      console.error("usage: mac.cjs sh '<command>' | sh -f <script> | put <local> <remote>");
      process.exitCode = 2;
    }
  } finally {
    session.close();
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
