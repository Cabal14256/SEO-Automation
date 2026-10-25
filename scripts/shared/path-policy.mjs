import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function containsPath(root, path, includeRoot = true) {
  const part = relative(resolve(root), resolve(path));
  return (includeRoot && part === '') || (part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

// Resolve every existing component, including junctions, before accepting a new path.
export function physicalPath(path) {
  let cursor = resolve(path);
  const missing = [];
  for (;;) {
    try { lstatSync(cursor); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor)); cursor = parent; continue;
    }
    return resolve(realpathSync.native(cursor), ...missing);
  }
}

const roles = {
  development: ['.local/development', true],
  data: ['.local/development/data', true],
  trial: ['.local/trial', true],
  release: ['.local/trial/releases', false],
  restore: ['.local/archive', false],
};

export function assertRuntimePath(repo, path, role = 'development') {
  if (!roles[role]) throw new Error('Unknown runtime path role');
  if (typeof path !== 'string' || !isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error('Runtime paths must be absolute without parent traversal');
  const source = resolve(repo); const target = resolve(path);
  const physicalSource = physicalPath(source); const physicalTarget = physicalPath(target);
  if (target === dirname(target) || physicalTarget === dirname(physicalTarget)) throw new Error('Runtime paths cannot be a filesystem root');
  const [privateRelative, includeRoot] = roles[role];
  if (containsPath(source, target)) {
    const privateName = relative(join(source, privateRelative), target).split(sep)[0];
    const physicalName = relative(join(physicalSource, privateRelative), physicalTarget).split(sep)[0];
    if (!containsPath(join(source, privateRelative), target, includeRoot)
      || !containsPath(join(physicalSource, privateRelative), physicalTarget, includeRoot)) {
      throw new Error(`In-repository ${role} paths must stay in ${privateRelative}`);
    }
    if (role === 'restore' && (!/^restore-[a-z0-9][a-z0-9._-]*$/i.test(privateName) || !/^restore-[a-z0-9][a-z0-9._-]*$/i.test(physicalName))) throw new Error('Restore paths must use an archive/restore-* directory');
    if (role === 'trial' && (containsPath(join(source, '.local/trial/releases'), target) || containsPath(join(physicalSource, '.local/trial/releases'), physicalTarget))) throw new Error('Mutable trial paths cannot use the releases directory');
  } else if (containsPath(target, source) || containsPath(physicalSource, physicalTarget) || containsPath(physicalTarget, physicalSource)) {
    throw new Error('External runtime paths must not overlap the source repository');
  }
  return target;
}

export function assertSeparatePaths(path, forbidden, message = 'Runtime paths must not overlap') {
  const target = resolve(path); const physicalTarget = physicalPath(path);
  for (const root of forbidden) {
    const normalized = resolve(root); const physicalRoot = physicalPath(root);
    if (containsPath(target, normalized) || containsPath(normalized, target)
      || containsPath(physicalTarget, physicalRoot) || containsPath(physicalRoot, physicalTarget)) throw new Error(message);
  }
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, repo, path, role] = process.argv.slice(2);
    const result = command === 'runtime' ? assertRuntimePath(repo, path, role)
      : command === 'physical' ? physicalPath(repo) : undefined;
    if (!result) throw new Error('Usage: path-policy.mjs runtime repository path role | physical path');
    process.stdout.write(result);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
