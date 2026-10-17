/**
 * What a saved file means for a running Flutter app: Dart code and assets
 * hot-reload; dependencies and an app's native folder need a rebuild; tests,
 * docs and what tools generate change nothing.
 */

/** `darwin`: a plugin's shared iOS and macOS code. */
export type FlutterChange = 'dart' | 'asset' | 'deps' | 'ios' | 'macos' | 'darwin' | 'windows' | 'ignore';

/** What Flutter, pub, CocoaPods, Xcode and CMake write themselves (never a reason to reload). */
const GENERATED = /(^|\/)(\.dart_tool|build|\.symlinks|Pods|ephemeral|\.pub-cache|\.pub|\.fvm|\.idea|\.vscode|\.git|\.capmac|DerivedData|xcuserdata|\.gradle|\.cxx|node_modules)(\/|$)|(^|\/)(\.flutter-plugins(-dependencies)?|\.packages|\.metadata|Generated\.xcconfig|flutter_export_environment\.sh|GeneratedPluginRegistrant\.\w+|generated_plugin_registrant\.(cc|h)|generated_plugins\.cmake|Flutter\.podspec)$|\.(iml|log|tmp|swp)$|~$/;

const DEPENDENCY_FILES = new Set(['pubspec.yaml', 'pubspec.lock', 'pubspec_overrides.yaml', '.fvmrc', 'capmac.json']);
/** The app's folders no Flutter build for iOS, the Mac or Windows reads. */
const UNUSED_TOP = new Set(['test', 'integration_test', 'test_driver', 'android', 'linux', 'web', 'fuchsia', 'docs', 'doc', 'example']);
const NATIVE = new Set(['ios', 'macos', 'darwin', 'windows']);

/** `rel`: POSIX path from the synced root; `projectRel`: the Flutter project from there ('' when it is the root). */
export function classifyFlutterChange(rel: string, projectRel: string): FlutterChange {
  if (GENERATED.test(rel)) return 'ignore';
  const inProject = projectRel === '' ? rel : rel.startsWith(`${projectRel}/`) ? rel.slice(projectRel.length + 1) : null;
  const parts = (inProject ?? rel).split('/');
  const base = parts.at(-1)!;
  if (DEPENDENCY_FILES.has(base)) return 'deps';
  if (inProject !== null) {
    if (UNUSED_TOP.has(parts[0]!)) return 'ignore';
    if (parts.length > 1 && NATIVE.has(parts[0]!)) return parts[0] as FlutterChange;
  }
  if (base.endsWith('.dart')) return 'dart';
  // A local package's (or plugin's) native code.
  const native = parts.slice(0, -1).find((part) => NATIVE.has(part));
  if (native) return native as FlutterChange;
  if (/\.(md|txt)$/i.test(base) || base.startsWith('.') || base === 'LICENSE') return 'ignore';
  // Anything else in the app (images, fonts, JSON, shaders) can be an asset: a hot reload brings it over.
  return 'asset';
}

/** Whether these changes need the app rebuilt (rather than hot reloaded), for the app running `app`. */
export function needsRebuild(changes: Iterable<FlutterChange>, app: 'ios' | 'macos' | 'windows'): boolean {
  for (const change of changes) {
    if (change === 'deps' || change === app || (change === 'darwin' && app !== 'windows')) return true;
  }
  return false;
}

/** Whether a change reaches the app running `app` at all (a hot reload or a rebuild). */
export function matters(change: FlutterChange, app: 'ios' | 'macos' | 'windows'): boolean {
  return change === 'dart' || change === 'asset' || change === 'deps' || change === app || (change === 'darwin' && app !== 'windows');
}
