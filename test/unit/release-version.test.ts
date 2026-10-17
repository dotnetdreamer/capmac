import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/set-version.mjs', import.meta.url));
const { setVersion } = await import(new URL('../../scripts/set-version.mjs', import.meta.url).href) as {
  setVersion(root: string, requested: string, options?: { dryRun?: boolean }): string;
};

type Package = {
  name: string;
  version: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const workspaceNames = {
  '': 'capmac-workspace',
  'packages/core': '@capmac/core',
  'packages/cli': 'capmac',
  'apps/desktop': '@capmac/desktop',
  'apps/vscode': 'capmac-vscode',
  'services/signal': '@capmac/signal',
};
const manifestFiles = Object.keys(workspaceNames).map((relative) => join(relative, 'package.json'));
const releaseFiles = [...manifestFiles, 'package-lock.json'];

describe('release version synchronization', () => {
  let root: string;

  const read = (relative: string) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
  const write = (relative: string, value: unknown) => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  const snapshot = () => releaseFiles.map((relative) => readFileSync(join(root, relative), 'utf8'));
  const fixture = (version = '1.2.3') => {
    const packages: Record<string, Package | object> = {};
    for (const [relative, name] of Object.entries(workspaceNames)) {
      const manifest: Package = { name, version, dependencies: { external: '1.2.3' } };
      if (relative === '') {
        manifest.workspaces = Object.keys(workspaceNames).slice(1);
        manifest.optionalDependencies = { '@capmac/core': version };
      }
      if (relative === 'packages/cli') manifest.devDependencies = { '@capmac/core': version };
      if (relative === 'apps/desktop') manifest.dependencies!['@capmac/core'] = version;
      if (relative === 'apps/vscode') manifest.devDependencies = { '@capmac/core': version };
      if (relative === 'services/signal') manifest.peerDependencies = { '@capmac/core': version };
      write(join(relative, 'package.json'), manifest);
      packages[relative] = manifest;
    }
    packages['node_modules/@capmac/core'] = { resolved: 'packages/core', link: true };
    packages['node_modules/external'] = {
      version: '1.2.3',
      resolved: 'https://registry.example/external.tgz',
      integrity: 'sha512-unchanged',
      peerDependencies: { '@capmac/core': '1.2.3' },
    };
    write('package-lock.json', { name: workspaceNames[''], version, lockfileVersion: 3, requires: true, packages });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'capmac-release-version-'));
    fixture();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['patch', '1.2.4'],
    ['minor', '1.3.0'],
    ['major', '2.0.0'],
    ['1.10.0', '1.10.0'],
    ['v2.0.1', '2.0.1'],
  ])('releases %s as %s across every workspace and the lock', (requested, expected) => {
    expect(setVersion(root, requested)).toBe(expected);
    for (const relative of manifestFiles) expect(read(relative).version).toBe(expected);
    const lock = read('package-lock.json');
    expect(lock.version).toBe(expected);
    for (const relative of Object.keys(workspaceNames)) expect(lock.packages[relative].version).toBe(expected);
  });

  it('updates every local core reference and preserves external dependencies and links', () => {
    const externalBefore = read('package-lock.json').packages['node_modules/external'];
    const linkBefore = read('package-lock.json').packages['node_modules/@capmac/core'];
    setVersion(root, 'minor');
    const lock = read('package-lock.json');
    for (const [relative, group] of [
      ['', 'optionalDependencies'],
      ['packages/cli', 'devDependencies'],
      ['apps/desktop', 'dependencies'],
      ['apps/vscode', 'devDependencies'],
      ['services/signal', 'peerDependencies'],
    ]) {
      expect(read(join(relative!, 'package.json'))[group!]['@capmac/core']).toBe('1.3.0');
      expect(lock.packages[relative!][group!]['@capmac/core']).toBe('1.3.0');
    }
    for (const relative of Object.keys(workspaceNames)) {
      expect(read(join(relative, 'package.json')).dependencies.external).toBe('1.2.3');
      expect(lock.packages[relative].dependencies.external).toBe('1.2.3');
    }
    expect(lock.packages['node_modules/external']).toEqual(externalBefore);
    expect(lock.packages['node_modules/@capmac/core']).toEqual(linkBefore);
  });

  it('preserves compact arrays, unrelated version fields and CRLF formatting', () => {
    const path = join(root, 'package.json');
    const source = readFileSync(path, 'utf8')
      .replace(/"workspaces": \[[\s\S]*?\]/, `"workspaces": ${JSON.stringify(Object.keys(workspaceNames).slice(1))}`)
      .replace('\n}', ',\n  "metadata": {"version": "1.2.3"}\n}')
      .replaceAll('\n', '\r\n');
    writeFileSync(path, source);
    setVersion(root, 'patch');
    expect(readFileSync(path, 'utf8')).toBe(source
      .replace('"version": "1.2.3"', '"version": "1.2.4"')
      .replace('"@capmac/core": "1.2.3"', '"@capmac/core": "1.2.4"'));
  });

  it('performs a fully validated dry run without changing any file', () => {
    const before = snapshot();
    expect(setVersion(root, 'v2.1.0', { dryRun: true })).toBe('2.1.0');
    expect(snapshot()).toEqual(before);
  });

  it.each([
    '1.2.3', '1.2.2', '0.9.9', '1.1.99',
    '01.2.4', '1.02.4', '1.2.04',
    '1.2', '1.2.4-beta.1', '1.2.4+build', 'V1.2.4',
    '1.2.4 ', '', '--force', '9007199254740992.0.0',
  ])('rejects invalid or non-increasing version %j without writes', (requested) => {
    const before = snapshot();
    expect(() => setVersion(root, requested)).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it.each(['patch', 'minor', 'major'])('rejects an unsafe %s increment without writes', (bump) => {
    const versions = { patch: '1.2.9007199254740991', minor: '1.9007199254740991.0', major: '9007199254740991.0.0' };
    fixture(versions[bump as keyof typeof versions]);
    const before = snapshot();
    expect(() => setVersion(root, bump)).toThrow(/safe integer range/);
    expect(snapshot()).toEqual(before);
  });

  it.each([false, true])('preflights late lock metadata before any writes (dryRun=%s)', (dryRun) => {
    const lock = read('package-lock.json');
    delete lock.packages['services/signal'];
    write('package-lock.json', lock);
    const before = snapshot();
    expect(() => setVersion(root, 'patch', { dryRun })).toThrow(/metadata for services\/signal/);
    expect(snapshot()).toEqual(before);
  });

  it('rejects missing lock references and a malformed final manifest before writing', () => {
    const lock = read('package-lock.json');
    delete lock.packages['services/signal'].peerDependencies['@capmac/core'];
    write('package-lock.json', lock);
    let before = snapshot();
    expect(() => setVersion(root, 'patch')).toThrow(/Inconsistent @capmac\/core references/);
    expect(snapshot()).toEqual(before);

    fixture();
    writeFileSync(join(root, 'services/signal/package.json'), '{ invalid JSON');
    before = snapshot();
    expect(() => setVersion(root, 'patch')).toThrow(/Could not read/);
    expect(snapshot()).toEqual(before);
  });

  it('rejects drift between workspace or lock versions before writing', () => {
    const manifest = read('packages/core/package.json');
    manifest.version = '1.2.2';
    write('packages/core/package.json', manifest);
    const before = snapshot();
    expect(() => setVersion(root, 'patch')).toThrow(/does not match package.json/);
    expect(snapshot()).toEqual(before);
  });

  it('the CLI resolves its repository from the script location and prints only the version', () => {
    const fixtureScript = join(root, 'scripts/set-version.mjs');
    mkdirSync(dirname(fixtureScript), { recursive: true });
    writeFileSync(fixtureScript, readFileSync(script));
    const before = snapshot();
    expect(execFileSync(process.execPath, [fixtureScript, '--dry-run', 'minor'], { cwd: tmpdir(), encoding: 'utf8' })).toBe('1.3.0\n');
    expect(snapshot()).toEqual(before);
    const invalid = spawnSync(process.execPath, [fixtureScript, 'patch', '--force'], { cwd: tmpdir(), encoding: 'utf8' });
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).toContain('Usage:');
    expect(snapshot()).toEqual(before);
    expect(execFileSync(process.execPath, [fixtureScript, 'patch'], { cwd: tmpdir(), encoding: 'utf8' })).toBe('1.2.4\n');
    expect(read('apps/desktop/package.json').version).toBe('1.2.4');
  });
});
