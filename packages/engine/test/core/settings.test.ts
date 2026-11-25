import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../../src/core/settings.js';

describe('Settings', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'engine-settings-'));
    file = join(dir, 'settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['script-a', 'script-a'],
    ['  script-a \n', 'script-a'],
    ['  ' + 'a'.repeat(32) + 'tail  ', 'a'.repeat(32)],
  ])('loads and normalizes the stored script %j', (stored, expected) => {
    writeFileSync(file, JSON.stringify({ jubenshaDefaultScript: stored }));
    expect(new Settings(file).jubenshaDefaultScript).toBe(expected);
  });

  it.each([42, null, '', ' \t\n'])('ignores an invalid stored script %j', (stored) => {
    writeFileSync(file, JSON.stringify({ jubenshaDefaultScript: stored }));
    expect(new Settings(file).jubenshaDefaultScript).toBeUndefined();
  });

  it('logs malformed JSON and starts without a default', () => {
    writeFileSync(file, '{"jubenshaDefaultScript":');
    const log = vi.fn();
    const settings = new Settings(file, log);
    expect(settings.jubenshaDefaultScript).toBeUndefined();
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\[settings\]/));
  });

  it('persists the script, reloads it and restricts file permissions', () => {
    const settings = new Settings(file);
    settings.setJubenshaDefaultScript('x');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ jubenshaDefaultScript: 'x' });
    expect(new Settings(file).jubenshaDefaultScript).toBe('x');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('clears a previously stored script in memory and on disk', () => {
    const settings = new Settings(file);
    settings.setJubenshaDefaultScript('x');
    settings.setJubenshaDefaultScript(null);
    expect(settings.jubenshaDefaultScript).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('jubenshaDefaultScript');
    expect(new Settings(file).jubenshaDefaultScript).toBeUndefined();
  });

  it('keeps changes in memory when no file is configured', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      renameSync: vi.fn(),
      writeFileSync: vi.fn(),
    }));
    try {
      const fs = await import('node:fs');
      const { Settings: MemorySettings } = await import('../../src/core/settings.js');
      const settings = new MemorySettings(null);
      settings.setJubenshaDefaultScript('x');
      expect(settings.jubenshaDefaultScript).toBe('x');
      settings.setJubenshaDefaultScript(null);
      expect(settings.jubenshaDefaultScript).toBeUndefined();
      for (const operation of [fs.existsSync, fs.mkdirSync, fs.readFileSync, fs.renameSync, fs.writeFileSync]) {
        expect(operation).not.toHaveBeenCalled();
      }
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  it('creates missing parent directories when saving', () => {
    const nested = join(dir, 'new', 'subdir', 'settings.json');
    new Settings(nested).setJubenshaDefaultScript('nested-script');
    expect(new Settings(nested).jubenshaDefaultScript).toBe('nested-script');
  });
});
