import { promises as fs } from 'node:fs';
import { AgentClient, type CallHandlers } from './agent-client.js';
import { ensureClientKey, loadGlobalConfig, resolveHost, updateHost, type HostConfig } from './config.js';
import { UserError } from './errors.js';
import { discoverRuntime } from './remote-env.js';
import { resolveMacAddress } from './resolve.js';
import { MacConnection } from './ssh.js';

export interface SessionOptions {
  /** Host alias from --mac (falls back to capmac.json, then the default host). */
  host?: string;
}

/** A live connection to a paired Mac with the agent ready to go. */
export class MacSession {
  private constructor(readonly host: HostConfig, readonly conn: MacConnection, public agent: AgentClient) {}

  static async open(options: SessionOptions = {}): Promise<MacSession> {
    const config = await loadGlobalConfig();
    const host = resolveHost(config, options.host);
    if (!host) {
      if (options.host) throw new UserError(`No paired Mac called "${options.host}".`, 'See paired Macs with `capmac macs`, or pair a new one with `capmac pair`.');
      if (Object.keys(config.hosts).length > 1) throw new UserError('Several Macs are paired and none is the default.', 'Pick one with --mac <name>, or set a default with `capmac pair --default <name>`.');
      throw new UserError('No Mac is paired yet.', 'Run `capmac pair` to connect this PC to your Mac.');
    }
    const privateKey = host.agent ? undefined : host.identityFile ? await fs.readFile(host.identityFile) : (await ensureClientKey()).privateKey;
    const resolved = await resolveMacAddress(host.host, host.lastAddress);
    const conn = await MacConnection.connect({
      host: resolved.address,
      label: host.host,
      port: host.port,
      username: host.username,
      privateKey,
      agent: host.agent,
      verifyHostKey: (fp) => fp === host.hostKey,
    });
    if (resolved.via !== 'unresolved' && resolved.via !== 'cache' && resolved.address !== host.lastAddress) {
      await updateHost(host.name, { lastAddress: resolved.address });
    }
    let { nodePath, home } = host;
    if (!nodePath || !home) {
      const runtime = await discoverRuntime(conn);
      if (!runtime.node) {
        conn.close();
        throw new UserError(`Node.js was not found on ${host.macName ?? host.host}.`, 'Run `capmac doctor --fix` to install a private copy, or install Node.js 20+ on the Mac (https://nodejs.org).');
      }
      nodePath = runtime.node.path;
      home = runtime.home;
      await updateHost(host.name, { nodePath, home });
    }
    return new MacSession(host, conn, new AgentClient(conn, nodePath, home));
  }

  get label(): string {
    return this.host.macName ?? this.host.host;
  }

  /** Runs an agent operation; re-discovers Node once if the configured one vanished. */
  async call<T>(op: string, params: object = {}, handlers: CallHandlers = {}): Promise<T> {
    try {
      return await this.agent.call<T>(op, params, handlers);
    } catch (err: any) {
      if (err?.code !== 'AGENT_CRASHED' || !/No such file|not found|command not found/i.test((err.tail ?? []).join('\n'))) throw err;
      const runtime = await discoverRuntime(this.conn);
      if (!runtime.node) throw new UserError('Node.js is no longer available on the Mac.', 'Run `capmac doctor --fix`.');
      await updateHost(this.host.name, { nodePath: runtime.node.path, home: runtime.home });
      this.agent = new AgentClient(this.conn, runtime.node.path, runtime.home);
      return this.agent.call<T>(op, params, handlers);
    }
  }

  close(): void {
    this.conn.close();
  }
}
