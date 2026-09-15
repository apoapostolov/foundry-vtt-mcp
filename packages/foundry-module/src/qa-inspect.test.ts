import { describe, expect, it } from 'vitest';
import { inspectApplications, inspectCombat, inspectHooks, inspectPackages, qaInspect } from './qa-inspect.js';
import { runtimeDiagnostics } from './runtime-diagnostics.js';

function makeModule(id: string, opts: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    version: '1.0.0',
    active: false,
    compatibility: { minimum: '13', verified: '14', maximum: '14' },
    relationships: { requires: [] },
    ...opts,
  };
}

describe('inspectPackages', () => {
  it('flags enabled but inactive modules and missing requires', () => {
    const dep = makeModule('lib-mod', { active: false });
    const target = makeModule('ui-mod', {
      active: false,
      relationships: { requires: [{ id: 'lib-mod', type: 'module' }] },
    });
    const game = {
      version: '14.367',
      system: { id: 'ose', title: 'OSE', version: '2.0.0' },
      settings: { get: () => ({ 'ui-mod': true, 'lib-mod': false }) },
      modules: {
        values: () => [dep, target],
        get: (id: string) => (id === 'lib-mod' ? dep : id === 'ui-mod' ? target : null),
      },
    };
    const result = inspectPackages(game);
    expect(result.counts.problems).toBe(1);
    expect(result.problems[0].id).toBe('ui-mod');
    expect(result.problems[0].problem).toBe('enabled_inactive');
    expect(result.problems[0].blocked_by).toEqual(['lib-mod']);
  });

  it('filters to an array of module ids', () => {
    const game = {
      settings: { get: () => ({}) },
      modules: { values: () => [makeModule('a'), makeModule('b')] },
    };
    const result = inspectPackages(game, ['b']);
    expect(result.modules.map(row => row.id)).toEqual(['b']);
  });
});

describe('inspectApplications', () => {
  it('lists AppV2 instances and AppV1 windows without dupes', () => {
    class FooSheet {}
    const app = Object.assign(new FooSheet(), { id: 'foo', title: 'Foo', rendered: true });
    const result = inspectApplications({
      foundry: { applications: { instances: new Map([['foo', app]]) } },
      ui: { windows: { foo: app } },
    });
    expect(result.count).toBe(1);
    expect(result.applications[0].class).toBe('FooSheet');
    expect(result.applications[0].v2).toBe(true);
  });
});

describe('inspectHooks', () => {
  it('counts listeners and marks hotspots', () => {
    const Hooks = {
      events: {
        init: new Array(3).fill({ fn: () => undefined }),
        renderChatMessage: new Array(14).fill({ fn: () => undefined }),
      },
    };
    const result = inspectHooks(Hooks);
    expect(result.listener_count).toBe(17);
    expect(result.hotspots.map(row => row.hook)).toEqual(['renderChatMessage']);
  });
});

describe('inspectCombat', () => {
  it('returns inactive when no combat', () => {
    expect(inspectCombat({ combat: null }).active).toBe(false);
  });
});

describe('qaInspect', () => {
  it('routes health', () => {
    const result = qaInspect(
      { action: 'health' },
      {
        game: {
          ready: true,
          version: '14.367',
          world: { id: 'test', title: 'Test' },
          user: { id: 'gm', name: 'GM', isGM: true },
          users: [{ active: true }],
          actors: { size: 2 },
          items: { size: 0 },
          scenes: { size: 1 },
          journal: { size: 0 },
          settings: { get: () => ({}) },
          modules: { values: () => [] },
          system: { id: 'ose', title: 'OSE', version: '1' },
        },
        Hooks: { events: {} },
        canvas: { ready: false },
      }
    ) as any;
    expect(result.ready).toBe(true);
    expect(result.documents.actors).toBe(2);
    expect(result.packages.installed).toBe(0);
  });
});

describe('inspectSettings', () => {
  it('redacts secret keys', () => {
    const game = {
      system: { id: 'ose' },
      settings: {
        get: (_ns: string, key: string) => (key === 'token' ? 'abc' : 'ok'),
        settings: {
          values: () => [
            { namespace: 'ose', key: 'token', scope: 'world' },
            { namespace: 'ose', key: 'theme', scope: 'client' },
          ],
        },
      },
    };
    const result = qaInspect({ action: 'settings', modules: 'ose' }, { game }) as any;
    const token = result.settings.find((row: any) => row.key === 'token');
    const theme = result.settings.find((row: any) => row.key === 'theme');
    expect(token.value).toBe('[redacted]');
    expect(theme.value).toBe('ok');
  });
});

describe('inspectApi and sockets', () => {
  it('lists api keys and socket listener counts', () => {
    const mod = makeModule('ui-mod', { active: true, api: { open: () => undefined, version: 1 } });
    const game = {
      settings: { get: () => ({ 'ui-mod': true }) },
      modules: { values: () => [mod], get: () => mod },
      socket: { listeners: (event: string) => (event === 'module.ui-mod' ? [1, 2] : []) },
      'ui-mod': { leftover: true },
    };
    const api = qaInspect({ action: 'api', modules: 'ui-mod' }, { game }) as any;
    expect(api.packages[0].api_keys.sort()).toEqual(['open', 'version']);
    expect(api.packages[0].game_global).toBe('object');
    const sockets = qaInspect({ action: 'sockets', modules: 'ui-mod' }, { game }) as any;
    expect(sockets.sockets[0].listeners).toBe(2);
  });
});

describe('qa-inspect check', () => {
  it('fails package-active and console-clean for a pinned module', () => {
    runtimeDiagnostics.clear();
    runtimeDiagnostics.ingest({
      consoleType: 'error',
      message: 'boom',
      stack: 'at x (http://127.0.0.1:30005/modules/ui-mod/main.js:1:1)',
    });
    const mod = makeModule('ui-mod', { active: false });
    const result = qaInspect(
      { action: 'check', modules: 'ui-mod' },
      {
        game: {
          ready: true,
          settings: { get: () => ({ 'ui-mod': true }) },
          modules: { values: () => [mod], get: () => mod },
        },
        canvas: { ready: false },
      }
    ) as any;
    expect(result.failed).toBeGreaterThan(0);
    const ids = result.checks.filter((row: any) => row.status === 'fail').map((row: any) => row.id);
    expect(ids).toContain('package-active');
    expect(ids).toContain('console-clean');
    runtimeDiagnostics.clear();
  });
});
