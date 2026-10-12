import { describe, expect, it } from 'vitest';
import { hintForBuildOutput, XcodeOutputParser, type XcodeEvent } from '../../src/shared/xcode-output.js';

const ROOT = '/Users/me/.capmac/projects/app-1/src';

function parse(text: string) {
  const parser = new XcodeOutputParser({ ownRoot: ROOT });
  const events: XcodeEvent[] = [];
  for (const line of text.split('\n')) events.push(...parser.push(line));
  events.push(...parser.end());
  return { parser, events, diags: events.filter((e) => e.kind === 'diag').map((e) => (e as any).diag), progress: events.filter((e) => e.kind === 'progress').map((e) => (e as any).text) };
}

const FAILED_BUILD = `Command line invocation:
    /Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project App.xcodeproj -scheme App

Resolve Package Graph

Fetching from https://github.com/ionic-team/capacitor-swift-pm.git

SwiftCompile normal arm64 Compiling\\ AppDelegate.swift ${ROOT}/ios/App/App/AppDelegate.swift (in target 'App' from project 'App')
    cd ${ROOT}/ios/App
    builtin-swiftTaskExecution -- /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend

${ROOT}/ios/App/App/AppDelegate.swift:12:9: error: cannot find 'foo' in scope
        foo()
        ^~~
${ROOT}/ios/App/App/AppDelegate.swift:12:9: error: cannot find 'foo' in scope
        foo()
        ^~~

/Users/me/.capmac/projects/app-1/DerivedData/SourcePackages/checkouts/x/Sources/X.swift:3:5: warning: 'bar' is deprecated
warning: Run script build phase '[CP] Embed Pods Frameworks' will be run during every build because it does not specify any outputs.
CompileC ${ROOT}/ios/App/Pods/build/Capacitor.o ${ROOT}/node_modules/@capacitor/ios/Capacitor/Capacitor/CAPBridgedJSTypes.m normal arm64 objective-c com.apple.compilers.llvm.clang.1_0.compiler (in target 'Capacitor' from project 'Pods')
Ld /Users/me/.capmac/projects/app-1/DerivedData/Build/Products/Debug-iphonesimulator/App.app/App normal (in target 'App' from project 'App')

** BUILD FAILED **


The following build commands failed:
\tSwiftCompile normal arm64 Compiling\\ AppDelegate.swift ${ROOT}/ios/App/App/AppDelegate.swift (in target 'App' from project 'App')
(1 failure)`;

describe('XcodeOutputParser', () => {
  it('extracts diagnostics with context, dedupes, and flags own files', () => {
    const { parser, diags } = parse(FAILED_BUILD);
    expect(parser.succeeded).toBe(false);
    expect(diags).toHaveLength(3);
    expect(diags[0]).toMatchObject({
      severity: 'error',
      file: `${ROOT}/ios/App/App/AppDelegate.swift`,
      line: 12,
      column: 9,
      message: "cannot find 'foo' in scope",
      own: true,
    });
    expect(diags[0].context).toEqual(['        foo()', '        ^~~']);
    expect(diags[1]).toMatchObject({ severity: 'warning', own: false, message: "'bar' is deprecated" });
    expect(diags[2]).toMatchObject({ severity: 'warning', own: false });
    expect(diags[2].file).toBeUndefined();
    expect(parser.errors).toBe(1);
    expect(parser.warnings).toBe(2);
    expect(parser.failedCommands).toHaveLength(1);
  });

  it('reports readable progress', () => {
    const { progress } = parse(FAILED_BUILD);
    expect(progress).toContain('Resolving Swift packages');
    expect(progress).toContain('Fetching https://github.com/ionic-team/capacitor-swift-pm.git');
    expect(progress).toContain('App › Compiling AppDelegate.swift');
    expect(progress).toContain('Capacitor › Compiling CAPBridgedJSTypes.m');
    expect(progress).toContain('App › Linking App');
  });

  it('keeps Swift 6 style source excerpts', () => {
    const { diags } = parse(`${ROOT}/ios/App/App/AppDelegate.swift:12:9: error: cannot find 'foo' in scope
10 |     func application() -> Bool {
11 |         // comment
12 |         foo()
   |         \`- error: cannot find 'foo' in scope
13 |         return true
14 |     }

** BUILD FAILED **`);
    expect(diags).toHaveLength(1);
    expect(diags[0].context).toHaveLength(6);
  });

  it('recognises signing and linker failures', () => {
    const { diags } = parse(`/Users/me/x/App.xcodeproj: error: Signing for "App" requires a development team. Select a development team in the Signing & Capabilities editor. (in target 'App' from project 'App')
Undefined symbols for architecture arm64:
  "_OBJC_CLASS_$_Foo", referenced from:
ld: symbol(s) not found for architecture arm64
** BUILD SUCCEEDED **`);
    expect(diags.map((d: any) => d.message)).toEqual([
      `Signing for "App" requires a development team. Select a development team in the Signing & Capabilities editor. (in target 'App' from project 'App')`,
      'Undefined symbols for architecture arm64:',
      'ld: symbol(s) not found for architecture arm64',
    ]);
    expect(diags[1].context).toEqual(['  "_OBJC_CLASS_$_Foo", referenced from:']);
  });

  it('suggests fixes for well-known failures', () => {
    expect(hintForBuildOutput('Command CodeSign failed: errSecInternalComponent')?.code).toBe('KEYCHAIN_LOCKED');
    expect(hintForBuildOutput('error: Signing for "App" requires a development team.')?.code).toBe('SIGNING');
    expect(hintForBuildOutput('xcodebuild: error: Unable to find a destination matching the provided destination specifier')?.hint).toMatch(/capmac targets/);
    expect(hintForBuildOutput('all good')).toBeNull();
  });
});
