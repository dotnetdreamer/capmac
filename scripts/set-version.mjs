// Keep the CLI, desktop, VS Code extension, shared engine and signaling service on one release.
// Prints only the resulting version so a workflow can capture it.
// Usage: node scripts/set-version.mjs <major|minor|patch|X.Y.Z> [--dry-run]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packages = ['', 'packages/core', 'packages/cli', 'apps/desktop', 'apps/vscode', 'services/signal'];
const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function components(version, label) {
  if (typeof version !== 'string' || !stableVersion.test(version)) {
    throw new Error(`${label} "${version}" must be a stable X.Y.Z version without leading zeros.`);
  }
  const result = version.split('.').map(Number);
  if (!result.every(Number.isSafeInteger)) {
    throw new Error(`${label} "${version}" has a component outside the safe integer range.`);
  }
  return result;
}

function nextVersion(current, requested) {
  const previous = components(current, 'Current version');
  if (typeof requested !== 'string') throw new Error('A release version or bump is required.');
  let next;
  const bump = ['major', 'minor', 'patch'].indexOf(requested);
  if (bump !== -1) {
    const parts = [...previous];
    parts[bump] += 1;
    for (let i = bump + 1; i < parts.length; i++) parts[i] = 0;
    next = parts.join('.');
  } else {
    next = requested.replace(/^v/, '');
  }
  const proposed = components(next, 'Requested version');
  const firstDifference = proposed.findIndex((part, index) => part !== previous[index]);
  if (firstDifference === -1 || proposed[firstDifference] < previous[firstDifference]) {
    throw new Error(`Version ${next} is not newer than the current ${current}.`);
  }
  return next;
}

function readJson(root, relative) {
  const path = join(root, relative);
  try {
    const source = readFileSync(path, 'utf8');
    return { path, relative, source, value: JSON.parse(source), updates: new Map() };
  } catch (error) {
    throw new Error(`Could not read ${relative}: ${error.message}`);
  }
}

function setString(document, path, value) {
  document.updates.set(JSON.stringify(path), value);
}

function coreReferences(document, value, path) {
  const references = [];
  for (const group of dependencyGroups) {
    const dependencies = value[group];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      throw new Error(`Invalid ${group} in ${document.relative}.`);
    }
    if (!Object.hasOwn(dependencies, '@capmac/core')) continue;
    if (typeof dependencies['@capmac/core'] !== 'string') {
      throw new Error(`Invalid @capmac/core reference in ${document.relative}.`);
    }
    references.push([...path, group, '@capmac/core']);
  }
  return references;
}

// JSON.parse validates the document above. Walk its tokens to replace only the
// chosen string values, preserving indentation, compact arrays and line endings.
function editedSource(document) {
  const tokens = [...document.source.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)];
  const edits = [];
  let cursor = 0;
  function visit(path) {
    const token = tokens[cursor++];
    if (token[0] === '{') {
      while (tokens[cursor][0] !== '}') {
        const key = JSON.parse(tokens[cursor++][0]);
        cursor++; // colon
        visit([...path, key]);
        if (tokens[cursor][0] === ',') cursor++;
      }
      cursor++;
    } else if (token[0] === '[') {
      let index = 0;
      while (tokens[cursor][0] !== ']') {
        visit([...path, index++]);
        if (tokens[cursor][0] === ',') cursor++;
      }
      cursor++;
    } else {
      const key = JSON.stringify(path);
      if (document.updates.has(key)) {
        if (!token[0].startsWith('"')) throw new Error(`Invalid version field in ${document.relative}.`);
        edits.push({ start: token.index, end: token.index + token[0].length, value: JSON.stringify(document.updates.get(key)) });
      }
    }
  }
  visit([]);
  if (edits.length !== document.updates.size) {
    throw new Error(`Missing or duplicate version metadata in ${document.relative}.`);
  }
  let source = document.source;
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}

/** Compute and optionally write the next release version in an explicit checkout. */
export function setVersion(root, requested, { dryRun = false } = {}) {
  const manifests = packages.map((relative) => readJson(root, join(relative, 'package.json')));
  const lock = readJson(root, 'package-lock.json');
  const current = manifests[0].value.version;
  const next = nextVersion(current, requested);
  if (lock.value.lockfileVersion !== 3 || !lock.value.packages || typeof lock.value.packages !== 'object') {
    throw new Error('package-lock.json must contain npm lockfile v3 workspace metadata.');
  }
  if (lock.value.version !== current) throw new Error('package-lock.json version does not match package.json.');
  setString(lock, ['version'], next);

  for (const [index, relative] of packages.entries()) {
    const manifest = manifests[index];
    components(manifest.value.version, `${manifest.relative} version`);
    if (manifest.value.version !== current) throw new Error(`${manifest.relative} version does not match package.json.`);
    const metadata = lock.value.packages[relative];
    if (!metadata || metadata.version !== current || metadata.name !== manifest.value.name) {
      throw new Error(`Missing or inconsistent package-lock.json metadata for ${relative || 'the root package'}.`);
    }
    setString(manifest, ['version'], next);
    setString(lock, ['packages', relative, 'version'], next);
    const manifestReferences = coreReferences(manifest, manifest.value, []);
    const lockReferences = coreReferences(lock, metadata, ['packages', relative]);
    if (JSON.stringify(manifestReferences) !== JSON.stringify(lockReferences.map((path) => path.slice(2)))) {
      throw new Error(`Inconsistent @capmac/core references in package-lock.json for ${relative || 'the root package'}.`);
    }
    for (const path of manifestReferences) setString(manifest, path, next);
    for (const path of lockReferences) setString(lock, path, next);
  }

  // Prepare every edit first, including on a dry run. Invalid metadata cannot
  // leave the earlier manifests changed or pass a release workflow's preflight.
  const edits = [...manifests, lock].map((document) => ({ path: document.path, source: editedSource(document) }));
  if (!dryRun) for (const edit of edits) writeFileSync(edit.path, edit.source);
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const requested = args.filter((arg) => arg !== '--dry-run');
  try {
    if (requested.length !== 1 || args.filter((arg) => arg === '--dry-run').length > 1) {
      throw new Error('Usage: node scripts/set-version.mjs <major|minor|patch|X.Y.Z> [--dry-run]');
    }
    console.log(setVersion(resolve(dirname(fileURLToPath(import.meta.url)), '..'), requested[0], { dryRun: args.includes('--dry-run') }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
