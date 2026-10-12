import { buildApp, loadApiKey, loadProject, MacLink, requireIos, type ExportKind } from '@capmac/core/engine';
import { cancelOnSigint } from '../cli-context.js';
import { terminalContext } from '../terminal.js';
import { log, pc } from '../ui.js';

export interface BuildCommandOptions {
  mac?: string;
  target?: string;
  device?: boolean;
  simulator?: boolean;
  configuration?: string;
  release?: boolean;
  scheme?: string;
  team?: string;
  clean?: boolean;
  full?: boolean;
  webBuild?: boolean;
  allWarnings?: boolean;
  xcodebuildArg?: string[];
  ipa?: boolean;
  export?: string;
  upload?: boolean;
  out?: string;
  apiKey?: string;
  apiKeyId?: string;
  apiIssuer?: string;
}

export async function buildCommand(options: BuildCommandOptions): Promise<void> {
  const project = await loadProject(process.cwd());
  requireIos(project);
  const auth = await loadApiKey(options, project);
  const { ctx } = terminalContext({ mode: 'other', allWarnings: options.allWarnings });
  const link = new MacLink(options.mac ?? project.config.host, ctx, { autoReconnect: false });
  const controller = new AbortController();
  const restore = cancelOnSigint(controller);
  try {
    const result = await buildApp(project, link, {
      ...options,
      auth,
      exportKind: options.export as ExportKind | undefined,
      outDir: options.out,
    }, ctx, controller.signal);
    if (result.kind === 'app') {
      log.success(`Built ${pc.bold(result.build.displayName)} ${pc.dim(`(${result.build.bundleId})`)}`);
      log.dim(`  on the Mac: ${result.build.appPath}`);
    } else if (result.kind === 'uploaded') {
      log.success('Uploaded to App Store Connect. It shows up in TestFlight once Apple finishes processing.');
    } else {
      log.success(`IPA ready: ${pc.bold(result.file)}`);
    }
  } finally {
    restore();
    link.close();
  }
}
