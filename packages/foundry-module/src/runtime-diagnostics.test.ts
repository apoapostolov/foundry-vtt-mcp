import { afterEach, describe, expect, it } from 'vitest';
import {
  RuntimeDiagnostics,
  classifyKind,
  extractPackageIds,
  normalizeModuleFilter,
  originOf,
  stripSelfFrames,
} from './runtime-diagnostics.js';

describe('runtime diagnostics helpers', () => {
  it('extracts module and system ids from stacks', () => {
    const text = 'Error\n at foo (http://127.0.0.1:30005/modules/session-transcripts/dist/main.js:1:1)';
    expect(extractPackageIds(text)).toEqual(['session-transcripts']);
  });

  it('ignores the bridge module id', () => {
    const text =
      'at x (http://127.0.0.1:30005/modules/foundry-mcp-bridge/dist/runtime-diagnostics.js:1:1)';
    expect(extractPackageIds(text)).toEqual([]);
  });

  it('classifies deprecation and performance', () => {
    expect(classifyKind('warn', 'Thing is deprecated since v13')).toBe('deprecation');
    expect(classifyKind('warn', 'Slow hook renderChatMessage 120ms')).toBe('performance');
    expect(classifyKind('error', 'Cannot read property foo')).toBe('error');
  });

  it('origin is module when a package path is present', () => {
    const stack = 'at x (http://127.0.0.1:30005/modules/foo-mod/main.js:8:2)';
    expect(originOf(extractPackageIds(stack), stack)).toBe('module');
  });

  it('normalizes module filters', () => {
    expect(normalizeModuleFilter('all')).toBe('all');
    expect([...normalizeModuleFilter(['Foo', 'core']) as Set<string>].sort()).toEqual([
      'core',
      'foo',
    ]);
  });

  it('strips self frames', () => {
    const stack = [
      'Error',
      '    at ingest (http://127.0.0.1:30005/modules/foundry-mcp-bridge/dist/runtime-diagnostics.js:1:1)',
      '    at foo (http://127.0.0.1:30005/modules/ose-reforged/main.js:4:1)',
    ].join('\n');
    const stripped = stripSelfFrames(stack) || '';
    expect(stripped).toContain('ose-reforged');
    expect(stripped).not.toContain('foundry-mcp-bridge');
  });
});

describe('RuntimeDiagnostics buffer', () => {
  const diag = new RuntimeDiagnostics();

  afterEach(() => {
    diag.clear();
    diag.uninstall();
  });

  it('polls errors for one module', () => {
    diag.ingest({
      consoleType: 'error',
      message: 'boom',
      stack: 'at x (http://127.0.0.1:30005/modules/ose-reforged/main.js:4:1)',
    });
    diag.ingest({
      consoleType: 'error',
      message: 'other',
      stack: 'at y (http://127.0.0.1:30005/modules/music-master/main.js:4:1)',
    });
    const result = diag.poll({ modules: 'ose-reforged' });
    expect(result.returned).toBe(1);
    expect(result.entries[0].packageId).toBe('ose-reforged');
    expect(result.entries[0].kind).toBe('error');
    expect(result.summary.errors).toBe(1);
    expect(result.entries[0].source_path).toBe('ose-reforged/main.js');
  });

  it('polls an array subset of modules plus core', () => {
    diag.ingest({
      consoleType: 'error',
      message: 'core fail',
      stack: 'at z (http://127.0.0.1:30005/scripts/foundry.mjs:10:1)',
    });
    diag.ingest({
      consoleType: 'warn',
      message: 'mod a',
      stack: 'at a (http://127.0.0.1:30005/modules/mod-a/main.js:1:1)',
    });
    diag.ingest({
      consoleType: 'warn',
      message: 'mod b',
      stack: 'at b (http://127.0.0.1:30005/modules/mod-b/main.js:1:1)',
    });
    const result = diag.poll({ modules: ['core', 'mod-a'] });
    const ids = result.entries.map(entry => entry.packageId || entry.origin).sort();
    expect(ids).toEqual(['core', 'mod-a']);
  });

  it('acks so a later poll is a delta', () => {
    diag.ingest({ consoleType: 'error', message: 'first' });
    const first = diag.poll({ ack: true });
    expect(first.returned).toBe(1);
    diag.ingest({ consoleType: 'error', message: 'second' });
    const second = diag.poll();
    expect(second.returned).toBe(1);
    expect(second.entries[0].message).toBe('second');
  });

  it('captures deprecation metadata', () => {
    diag.ingest({
      kind: 'deprecation',
      message: 'TokenHUD is deprecated',
      since: '13',
      until: '15',
    });
    const result = diag.poll({ kinds: ['deprecation'] });
    expect(result.entries[0].deprecation).toBe(true);
    expect(result.entries[0].since).toBe('13');
  });

  it('captures performance warnings', () => {
    diag.ingest({ consoleType: 'warn', message: 'Slow hook canvasDraw 80ms' });
    const result = diag.poll({ kinds: ['performance'] });
    expect(result.returned).toBe(1);
    expect(result.entries[0].kind).toBe('performance');
  });
});
