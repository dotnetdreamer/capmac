import { describe, expect, it } from 'vitest';
import { classifyChange, summarizeChanges } from '../../packages/core/src/shared/classify.js';
import { classifyAppLine } from '../../packages/core/src/shared/app-log.js';
import { PathMapper } from '../../packages/core/src/shared/paths.js';

describe('classifyChange', () => {
  const ctx = { projectRel: '', webDir: 'dist', iosDir: 'ios' };

  it.each([
    ['package.json', 'deps'],
    ['package-lock.json', 'deps'],
    ['packages/ui/package.json', 'deps'],
    ['capacitor.config.ts', 'capconfig'],
    ['dist/index.html', 'web'],
    ['dist/assets/app.js', 'web'],
    ['ios/App/Podfile', 'pods'],
    ['ios/App/CapApp-SPM/Package.swift', 'pods'],
    ['ios/App/App/AppDelegate.swift', 'native'],
    ['ios/App/App.xcodeproj/project.pbxproj', 'native'],
    ['ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json', 'native'],
    ['ios/App/App/public/index.html', 'web'],
    ['ios/App/App/capacitor.config.json', 'web'],
    ['src/app/app.component.ts', 'other'],
    ['README.md', 'other'],
    ['plugins/my-plugin/ios/Sources/MyPlugin/MyPlugin.swift', 'native'],
    ['plugins/my-plugin/MyPlugin.podspec', 'native'],
  ])('%s -> %s', (rel, kind) => {
    expect(classifyChange(rel, ctx)).toBe(kind);
  });

  it('understands monorepo layouts', () => {
    const mono = { projectRel: 'apps/mobile', webDir: 'www', iosDir: 'ios' };
    expect(classifyChange('apps/mobile/www/main.js', mono)).toBe('web');
    expect(classifyChange('apps/mobile/ios/App/App/Info.plist', mono)).toBe('native');
    expect(classifyChange('apps/mobile/capacitor.config.ts', mono)).toBe('capconfig');
    expect(classifyChange('apps/web/www/main.js', mono)).toBe('other');
    expect(classifyChange('pnpm-lock.yaml', mono)).toBe('deps');
  });

  it('summarizes', () => {
    const s = summarizeChanges(['dist/a.js', 'ios/App/App/AppDelegate.swift'], ctx);
    expect(s).toMatchObject({ web: true, native: true, deps: false, pods: false });
  });
});

describe('classifyAppLine', () => {
  it('parses Capacitor console forwarding', () => {
    expect(classifyAppLine('⚡️  [log] - Hello world')).toEqual({ kind: 'console', level: 'log', text: 'Hello world' });
    expect(classifyAppLine('⚡️  [warn] - careful')).toMatchObject({ kind: 'console', level: 'warn', text: 'careful' });
    expect(classifyAppLine('⚡️  [error] - {"message":"boom"}')).toMatchObject({ kind: 'console', level: 'error' });
    expect(classifyAppLine('⚡️  To Native ->  Device getInfo 12345')).toMatchObject({ kind: 'bridge' });
    expect(classifyAppLine('⚡️  TO JS {"model":"iPhone"}')).toMatchObject({ kind: 'bridge' });
    expect(classifyAppLine('⚡️  Loading app at capacitor://localhost...')).toMatchObject({ kind: 'capacitor', level: 'info' });
    expect(classifyAppLine('⚡️  WebView failed to load')).toMatchObject({ kind: 'capacitor', level: 'error' });
    expect(classifyAppLine('2024-01-01 App[123:456] some native log')).toMatchObject({ kind: 'native', level: 'log' });
    expect(classifyAppLine('Fatal error: Unexpectedly found nil')).toMatchObject({ kind: 'native', level: 'error' });
  });
});

describe('PathMapper', () => {
  const mapper = new PathMapper('/Users/me/.capmac/projects/app-1/src', 'C:\\Users\\ik\\app');

  it('maps single paths', () => {
    expect(mapper.toLocal('/Users/me/.capmac/projects/app-1/src/ios/App/App/AppDelegate.swift')).toBe('C:\\Users\\ik\\app\\ios\\App\\App\\AppDelegate.swift');
    expect(mapper.toLocal('/Users/me/.capmac/projects/app-1/src')).toBe('C:\\Users\\ik\\app');
    expect(mapper.toLocal('/Applications/Xcode.app')).toBe('/Applications/Xcode.app');
    expect(mapper.toLocal('/Users/me/.capmac/projects/app-1/srcfoo/x')).toBe('/Users/me/.capmac/projects/app-1/srcfoo/x');
  });

  it('maps paths inside text, keeping line/column suffixes', () => {
    expect(mapper.mapText("error at /Users/me/.capmac/projects/app-1/src/ios/App/App/AppDelegate.swift:12:9 (in target 'App')")).toBe(
      "error at C:\\Users\\ik\\app\\ios\\App\\App\\AppDelegate.swift:12:9 (in target 'App')",
    );
    expect(mapper.mapText('nothing to see')).toBe('nothing to see');
  });
});
