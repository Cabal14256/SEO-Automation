import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, resolveDataDirectory } from './config.js';

const required = { DATABASE_URL: 'postgresql://offline:offline@127.0.0.1:5432/offline',
  BETTER_AUTH_SECRET: 'offline-configuration-secret-with-32-characters', DATA_DIR: join(tmpdir(), 'scm-config-offline') };

describe('private data directory policy', () => {
  it('accepts designated private development data and external release data', () => {
    const root = mkdtempSync(join(tmpdir(), 'scm-config-path-'));
    try {
      const repo = join(root, 'source'); mkdirSync(repo);
      const data = join(repo, '.local/development/data');
      expect(resolveDataDirectory(repo, data)).toBe(data);
      expect(resolveDataDirectory(join(repo, '.local/trial/releases/r1'), join(repo, '.local/trial/data'))).toBe(join(repo, '.local/trial/data'));
      expect(resolveDataDirectory(repo, join(root, 'external-data'))).toBe(join(root, 'external-data'));
      for (const name of ['', '.local', '.local-evil', 'apps', '.local/development', '.local/trial/data', '.local/archive/restore-old/data']) {
        expect(() => resolveDataDirectory(repo, join(repo, name))).toThrow();
      }
      expect(() => resolveDataDirectory(repo, `${repo}/.local/development/../data`)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects links escaping private data and external aliases into source', () => {
    const root = mkdtempSync(join(tmpdir(), 'scm-config-links-'));
    try {
      const repo = join(root, 'source'); const outside = join(root, 'outside');
      mkdirSync(join(repo, '.local/development'), { recursive: true }); mkdirSync(outside);
      symlinkSync(outside, join(repo, '.local/development/data'), 'junction');
      expect(() => resolveDataDirectory(repo, join(repo, '.local/development/data/new'))).toThrow();
      const alias = join(root, 'alias'); symlinkSync(repo, alias, 'junction');
      expect(() => resolveDataDirectory(repo, join(alias, 'apps/data'))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('Lingxing outbound configuration', () => {
  it('keeps requests enabled by default and parses false as a boolean false', () => {
    expect(readConfig(required).LINGXING_REQUESTS_ENABLED).toBe(true);
    expect(readConfig({ ...required, LINGXING_REQUESTS_ENABLED: 'true' }).LINGXING_REQUESTS_ENABLED).toBe(true);
    expect(readConfig({ ...required, LINGXING_REQUESTS_ENABLED: 'false' }).LINGXING_REQUESTS_ENABLED).toBe(false);
  });

  it('rejects misspelled switches instead of silently enabling outbound traffic', () => {
    for (const value of ['False', '0', 'no', '', ' false ']) {
      expect(() => readConfig({ ...required, LINGXING_REQUESTS_ENABLED: value })).toThrow();
    }
  });
});
