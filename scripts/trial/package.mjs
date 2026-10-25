import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { exists, inventory, run, sha256 } from './core.mjs';
import { assertRuntimePath } from '../shared/path-policy.mjs';

const forbiddenPart = /^(?:\.git|\.local|node_modules|private|data|coverage|test-results|playwright-report|__pycache__|__tests__|__fixtures__)$/i;
const forbiddenName = /^(?:\.env(?:\..*)?|.*\.local\.json|.*\.(?:key|pem|pfx|p12|db|sqlite3?|dump|backup|scmbak|bundle|log|pid|tsbuildinfo|xlsx?|xlsm|csv|tsv|docx|pdf|zip|rar|7z|tar|gz|tgz))$/i;
export const sourceExclusions = ['**/.env*', '**/*.local.json', '**/*.{key,pem,pfx,p12,db,sqlite,sqlite3,dump,backup,scmbak,bundle,log,pid,tsbuildinfo}', '**/*.{xls,xlsx,xlsm,csv,tsv,docx,pdf,zip,rar,7z,tar,gz,tgz}', '.git/**', '.local/**', '**/private/**', '**/data/**', '**/*.{test,spec}.*', '**/*-acceptance.*', '**/*-browser.*', '**/__tests__/**', '**/__fixtures__/**', 'scripts/acceptance/**', 'docs/research/**', 'docs/acceptance/evidence/**', 'docs/templates/**', 'source-node_modules/**', 'docs/non-Markdown-files'];
export function includeSource(name) {
  name = name.replaceAll('\\', '/');
  const parts = name.split('/');
  return !parts.some((part) => forbiddenPart.test(part)) && !forbiddenName.test(parts.at(-1))
    && !/(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(name)
    && !/(?:^|\/)[^/]+-(?:acceptance|browser)\.[^/]+(?:\.map)?$/i.test(name)
    && !/^(?:scripts\/acceptance|docs\/research|docs\/acceptance\/evidence|docs\/templates)(?:\/|$)/i.test(name);
}
async function sourceTree(source, target, prefix = '', dependency = false) {
  await mkdir(target, { recursive: true });
  const pending = [];
  async function flush() {
    const results = await Promise.allSettled(pending.splice(0));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (dependency ? /^(?:node_modules|\.git)$/.test(entry.name) || /^\.env(?:\..*)?$/.test(entry.name) : !includeSource(name)) continue;
    if (!dependency && prefix.startsWith('docs') && entry.isFile() && !entry.name.endsWith('.md')) continue;
    const from = join(source, entry.name); const to = join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source links are not allowed: ${name}`);
    if (entry.isDirectory()) { await flush(); await sourceTree(from, to, name, dependency); }
    else if (entry.isFile()) { pending.push(copyFile(from, to)); if (pending.length === 16) await flush(); }
  }
  await flush();
}
async function dependencyPath(source, name) {
  const require = createRequire(join(source, 'package.json'));
  for (const lookup of require.resolve.paths(name) ?? []) {
    const candidate = join(lookup, name);
    if (await exists(join(candidate, 'package.json'))) return realpath(candidate);
  }
  throw new Error(`Installed production dependency is missing: ${name}`);
}
export async function materializeProductionDependencies(source, target) {
  const graph = new Map();
  async function visit(path) {
    path = await realpath(path);
    if (graph.has(path)) return graph.get(path);
    const info = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    const node = { id: path, source: path, info, edges: new Map() }; graph.set(path, node);
    if (graph.size > 3000) throw new Error('Unexpectedly large production dependency graph');
    // An installed optional peer may exist solely for workspace development
    // (for example Vitest). Only the production graph may opt into that peer.
    const mandatoryPeers = Object.fromEntries(Object.entries(info.peerDependencies ?? {}).filter(([name]) => !info.peerDependenciesMeta?.[name]?.optional));
    const requirements = { ...mandatoryPeers, ...info.dependencies, ...info.optionalDependencies };
    for (const name of Object.keys(requirements).sort((a, b) => a.localeCompare(b, 'en'))) {
      if (builtinModules.includes(name) || name.startsWith('node:')) continue;
      let dependency;
      try { dependency = await dependencyPath(path, name); }
      catch (error) { if (info.optionalDependencies?.[name] || info.peerDependenciesMeta?.[name]?.optional) continue; throw error; }
      node.edges.set(name, await visit(dependency));
    }
    return node;
  }
  const root = await visit(source);
  // Resolve optional peer contexts only when that package is independently
  // selected by a production dependency or mandatory peer. Repeat because an
  // opted-in peer can itself add genuine production dependencies.
  let changed;
  do {
    changed = false;
    const selected = new Set([...graph.values()].flatMap((node) => [...node.edges.keys()]));
    for (const node of graph.values()) for (const name of Object.keys(node.info.peerDependencies ?? {})) {
      if (!node.info.peerDependenciesMeta?.[name]?.optional || !selected.has(name) || node.edges.has(name)) continue;
      let path;
      try { path = await dependencyPath(node.source, name); } catch { continue; }
      node.edges.set(name, await visit(path)); changed = true;
    }
  } while (changed);
  const defaults = new Map(root.edges);
  for (const node of graph.values()) for (const [name, dependency] of node.edges) if (!defaults.has(name)) defaults.set(name, dependency);
  const installed = new Map(); const collected = [];
  async function copy(node, destination) {
    if (collected.length > 10000) throw new Error('Unexpectedly large materialized dependency graph');
    await sourceTree(node.source, destination, '', true);
    installed.set(resolve(destination), node);
    collected.push({ name: node.info.name, version: node.info.version, path: destination });
  }
  // Hoist one real package per dependency name first, prioritizing direct
  // application dependencies. Conflicting versions or peer contexts are then
  // installed inside the requiring package to preserve actual Node resolution.
  for (const [name, node] of defaults) await copy(node, join(target, 'node_modules', name));
  const processed = new Set();
  async function populate(node, destination) {
    if (processed.has(destination)) return; processed.add(destination);
    for (const [name, dependency] of node.edges) {
      const require = createRequire(join(destination, 'package.json'));
      let actual;
      for (const lookup of require.resolve.paths(name) ?? []) {
        const candidate = resolve(lookup, name);
        if (installed.has(candidate)) { actual = installed.get(candidate); break; }
      }
      if (actual?.id === dependency.id) continue;
      const nested = join(destination, 'node_modules', name);
      await copy(dependency, nested); await populate(dependency, nested);
    }
  }
  for (const [name, node] of defaults) await populate(node, join(target, 'node_modules', name));
  return collected;
}
export async function packageRelease({ repo, target }) {
  repo = resolve(repo); target = assertRuntimePath(repo, target, 'release');
  if (await exists(target)) throw new Error('Release target already exists');
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 1)) throw new Error('Release must be built with Node.js >=24.22.1 <25');
  for (const path of ['apps/server/dist/api.js', 'apps/server/dist/worker.js', 'apps/web/dist/index.html', 'packages/contracts/dist/index.js', 'pnpm-lock.yaml']) {
    if (!await exists(join(repo, path))) throw new Error(`Required build artifact missing: ${path}`);
  }
  await mkdir(target, { recursive: true });
  for (const directory of ['apps', 'packages', 'scripts', 'docs']) await sourceTree(join(repo, directory), join(target, directory), directory);
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'README.md', 'eslint.config.mjs']) {
    if (await exists(join(repo, name))) await copyFile(join(repo, name), join(target, name));
  }
  const dependencies = await materializeProductionDependencies(join(repo, 'apps/server'), join(target, 'apps/server'));
  await mkdir(join(target, 'runtime')); await copyFile(process.execPath, join(target, 'runtime/node.exe'));
  // A fresh process must resolve the complete server production import graph
  // with no references to the checkout's node_modules or package manager.
  await run(join(target, 'runtime/node.exe'), ['--input-type=module', '-e', "await Promise.all(['pg','exceljs','hono','pg-boss','better-auth','@better-auth/drizzle-adapter','@scm/contracts','drizzle-orm','zod'].map(x=>import(x)))"], { cwd: join(target, 'apps/server'), env: { ...process.env, NODE_PATH: '' } });
  const files = await inventory(target);
  const dirty = (await run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo })).split(/\r?\n/).filter(Boolean).filter((line) => includeSource(line.slice(3)));
  const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).trim();
  const createdAt = new Date().toISOString();
  const contentSha256 = sha256(JSON.stringify(files));
  const manifest = { format: 'scm-trial-release/v1', releaseId: `${createdAt.replaceAll(':', '-').replaceAll('.', '-')}-${contentSha256.slice(0, 12)}`, createdAt, gitHead: head, dirtyFiles: dirty, nodeVersion: process.version, runtime: 'runtime/node.exe', sourceExclusions, contentSha256, productionPackages: [...new Set(dependencies.map((item) => `${item.name}@${item.version}`))].sort(), ruleFiles: files.filter((item) => /(?:business-rules|development-plan|migrations|drizzle\/.*\.sql|contracts\/dist)/.test(item.path)), inventory: files };
  await writeFile(join(target, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { result: 'passed', releaseId: manifest.releaseId, target, nodeVersion: process.version, files: files.length, productionPackages: manifest.productionPackages.length, contentSha256, dirtyFiles: dirty.length, secretsExcluded: true, externalBusinessRequests: 0 };
}
