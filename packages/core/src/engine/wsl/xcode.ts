/** Preserve the native Xcode app while importing its locked Swift package graph. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { throwIfAborted, type EngineContext } from '../context.js';
import { UserError } from '../errors.js';
import type { ProjectInfo } from '../project.js';
import { mirrorWslWorkspace, syncMirroredCapacitor, type CocoaPodsOptions } from './cocoapods.js';
import type { WslNativeBuildPlan } from './native-compiler.js';
import { importSwiftPackages, type WslXcodeGraph } from './swift-packages.js';
import exporter from './pods-export.rb';

export type XcodeProjectOptions = Omit<CocoaPodsOptions, 'podPath'>;

export async function prepareXcodeProject(project: ProjectInfo, options: XcodeProjectOptions,
  ctx: EngineContext, signal: AbortSignal): Promise<WslNativeBuildPlan> {
  throwIfAborted(signal);
  const { workspace, workspaceWsl } = await mirrorWslWorkspace(project, options.directory, options.executor, signal);
  await syncMirroredCapacitor(project, workspace, ctx, signal, 'SPM');
  const rubyPath = options.rubyPath ?? 'ruby';
  const probe = await options.executor.run([rubyPath, '-rxcodeproj', '-e', 'puts Xcodeproj::VERSION'], { signal, allowFailure: true });
  if (probe.code !== 0) throw new UserError('The native Xcode importer needs the Ruby xcodeproj gem in WSL.', 'Install it with gem install xcodeproj --no-document.', probe.stderr.trim().split(/\r?\n/).slice(-12));
  const rubyFile = path.join(options.directory, 'xcode-export.rb');
  const nativeFile = path.join(options.directory, 'xcode-graph.json');
  const completeFile = path.join(options.directory, 'native-graph.json');
  await fs.writeFile(rubyFile, exporter);
  const iosRelative = path.relative(project.syncRoot, path.resolve(project.capDir, project.iosDir)).split(path.sep).join('/');
  if (iosRelative.startsWith('../') || path.posix.isAbsolute(iosRelative)) throw new UserError('The iOS project is outside the isolated workspace.');
  const [rubyWsl, nativeWsl] = await Promise.all([options.executor.path(rubyFile, signal), options.executor.path(nativeFile, signal)]);
  await options.executor.run([rubyPath, rubyWsl], { signal, timeoutMs: 120_000,
    stdin: JSON.stringify({ projectRoot: workspaceWsl, projectDirectory: `${workspaceWsl}/${iosRelative}`, swiftPackages: true,
      configuration: options.configuration, sdkPath: options.tools.sdkPath, scheme: options.scheme ?? project.scheme,
      output: nativeWsl, liveUrl: options.liveUrl, xcodeVersion: options.xcodeVersion }),
    onOutput: (text, stream) => ctx.emit({ type: 'tool-output', text, stream }) });
  const graph = JSON.parse(await fs.readFile(nativeFile, 'utf8')) as WslXcodeGraph;
  const imported = await importSwiftPackages(graph, options.executor, {
    outputPath: completeFile, generatedDirectory: path.join(options.directory, 'swift-generated'), tools: options.tools,
  }, ctx, signal);
  return { graph: imported, outputDirectory: options.outputDirectory, signing: options.signing };
}
