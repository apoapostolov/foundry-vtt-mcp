import { runtimeDiagnostics } from './runtime-diagnostics.js';

export type QaInspectAction =
  | 'packages'
  | 'applications'
  | 'hooks'
  | 'canvas'
  | 'combat'
  | 'health'
  | 'settings'
  | 'api'
  | 'sockets'
  | 'check';

export interface QaInspectOptions {
  action: QaInspectAction;
  modules?: string | string[] | null;
  hook?: string | null;
  limit?: number;
}

export type QaInspectCtx = {
  game?: any;
  canvas?: any;
  foundry?: any;
  ui?: any;
  Hooks?: any;
  document?: Document | null;
};

const HOOK_HOTSPOT = 12;
const FPS_FLOOR = 20;
const SECRET_RE = /password|secret|token|apikey|api[_-]?key|license|credential|(^|[._-])auth([._-]|$)/i;
const DOTTED_I18N = /^[A-Z][A-Z0-9]+(\.[A-Z0-9_]+)+$/;

function asList(value: unknown): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof (value as any).values === 'function') return Array.from((value as any).values());
  if (Array.isArray((value as any).contents)) return (value as any).contents;
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>);
  return [];
}

function normalizeFilter(modules?: string | string[] | null): Set<string> | null {
  if (modules == null || modules === '' || modules === 'all' || modules === '*') return null;
  const list = (Array.isArray(modules) ? modules : [modules])
    .map(id => String(id).trim().toLowerCase())
    .filter(Boolean);
  if (!list.length || list.includes('all') || list.includes('*')) return null;
  return new Set(list);
}

function requireIds(mod: any): { id: string; type: string }[] {
  return asList(mod?.relationships?.requires)
    .map(entry => ({
      id: String(entry?.id || ''),
      type: String(entry?.type || 'module'),
    }))
    .filter(entry => entry.id);
}

function enabledModuleIds(game: any): string[] {
  const config = (game?.settings?.get?.('core', 'moduleConfiguration') || {}) as Record<
    string,
    boolean
  >;
  return Object.keys(config).filter(id => config[id] === true);
}

function targetIds(game: any, modules?: string | string[] | null): string[] {
  const filter = normalizeFilter(modules);
  if (filter) return [...filter];
  return enabledModuleIds(game);
}

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_RE.test(key)) return '[redacted]';
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

function socketListenerCount(socket: any, event: string): number {
  if (!socket) return 0;
  if (typeof socket.listeners === 'function') return socket.listeners(event).length;
  const bag = socket._callbacks || socket._events || {};
  return asList(bag[event]).length;
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value as object).slice(0, 80);
}

export function inspectPackages(game: any, modules?: string | string[] | null) {
  const config = (game?.settings?.get?.('core', 'moduleConfiguration') || {}) as Record<
    string,
    boolean
  >;
  const filter = normalizeFilter(modules);
  const rows = asList(game?.modules)
    .map(mod => {
      const id = String(mod.id || '');
      const enabled = config[id] === true;
      const active = !!mod.active;
      const requires = requireIds(mod);
      const blockedBy = requires.filter(req => {
        if (req.type && req.type !== 'module') return false;
        const dep = game?.modules?.get?.(req.id);
        if (!dep) return true;
        return config[req.id] !== true;
      });
      const unavailable = !!(mod.unavailable || mod.disabled);
      return {
        id,
        title: String(mod.title || id),
        version: String(mod.version || ''),
        active,
        enabled,
        unavailable,
        compatibility: {
          minimum: mod.compatibility?.minimum ?? null,
          verified: mod.compatibility?.verified ?? null,
          maximum: mod.compatibility?.maximum ?? null,
        },
        blocked_by: blockedBy.map(entry => entry.id),
        problem:
          enabled && !active
            ? 'enabled_inactive'
            : unavailable
              ? 'unavailable'
              : blockedBy.length && enabled
                ? 'blocked_requires'
                : null,
      };
    })
    .filter(row => (filter ? filter.has(row.id.toLowerCase()) : true));

  const system = game?.system
    ? {
        id: String(game.system.id || ''),
        title: String(game.system.title || game.system.id || ''),
        version: String(game.system.version || ''),
      }
    : null;

  const problems = rows.filter(row => row.problem);
  return {
    core: String(game?.version || ''),
    system,
    counts: {
      installed: rows.length,
      enabled: rows.filter(row => row.enabled).length,
      active: rows.filter(row => row.active).length,
      problems: problems.length,
    },
    problems,
    modules: rows,
  };
}

export function inspectApplications(root: { foundry?: any; ui?: any } = globalThis as any) {
  const v2 = asList(root.foundry?.applications?.instances).map(app => describeApp(app, true));
  const v1 = asList(root.ui?.windows).map(app => describeApp(app, false));
  const seen = new Set<string>();
  const apps = [...v2, ...v1].filter(app => {
    if (!app.id && !app.class) return false;
    const key = app.id || `${app.class}:${app.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { count: apps.length, applications: apps };
}

function describeApp(app: any, v2: boolean) {
  return {
    id: String(app?.id || app?.appId || ''),
    class: String(app?.constructor?.name || ''),
    title: String(app?.title || app?.window?.title || ''),
    rendered: app?.rendered !== false,
    minimized: !!(app?.minimized || app?.window?.minimized),
    v2,
  };
}

export function inspectHooks(Hooks: any, hook?: string | null, limit = 30) {
  const events = Hooks?.events || {};
  const names = hook ? [hook] : Object.keys(events);
  const rows = names
    .map(name => {
      const listeners = asList(events[name]);
      return { hook: name, listeners: listeners.length };
    })
    .filter(row => row.listeners > 0)
    .sort((a, b) => b.listeners - a.listeners);
  const capped = rows.slice(0, Math.min(Math.max(limit, 1), 100));
  return {
    hook_count: Object.keys(events).length,
    listener_count: rows.reduce((sum, row) => sum + row.listeners, 0),
    hotspots: rows.filter(row => row.listeners >= HOOK_HOTSPOT),
    hooks: capped,
  };
}

export function inspectCanvas(canvas: any) {
  const ticker = canvas?.app?.ticker;
  const fps = typeof ticker?.FPS === 'number' ? Math.round(ticker.FPS) : null;
  return {
    ready: !!canvas?.ready,
    fps,
    scene: canvas?.scene
      ? { id: String(canvas.scene.id || ''), name: String(canvas.scene.name || '') }
      : null,
    tokens: canvas?.tokens?.placeables?.length ?? 0,
    lights: canvas?.lighting?.placeables?.length ?? 0,
    walls: canvas?.walls?.placeables?.length ?? 0,
    notes: canvas?.notes?.placeables?.length ?? 0,
    sounds: canvas?.sounds?.placeables?.length ?? 0,
    templates: canvas?.templates?.placeables?.length ?? 0,
    tiles: canvas?.tiles?.placeables?.length ?? 0,
  };
}

export function inspectCombat(game: any) {
  const combat = game?.combat;
  if (!combat) return { active: false };
  return {
    active: true,
    started: !!combat.started,
    round: combat.round ?? 0,
    turn: combat.turn ?? 0,
    combatants: combat.combatants?.size ?? asList(combat.combatants).length,
    scene: combat.scene?.id || combat.sceneId || null,
  };
}

export function inspectSettings(game: any, modules?: string | string[] | null) {
  const filter = normalizeFilter(modules);
  const namespaces = filter
    ? [...filter]
    : [...enabledModuleIds(game), String(game?.system?.id || '')].filter(Boolean);
  const allowed = new Set(namespaces.map(id => id.toLowerCase()));
  const settings: Array<Record<string, unknown>> = [];
  for (const setting of asList(game?.settings?.settings)) {
    const namespace = String(setting.namespace || setting.config?.namespace || '');
    const key = String(setting.key || setting.config?.key || '');
    if (!namespace || !key) continue;
    if (!allowed.has(namespace.toLowerCase())) continue;
    let value: unknown = null;
    try {
      value = game.settings.get(namespace, key);
    } catch {
      value = null;
    }
    settings.push({
      namespace,
      key,
      scope: setting.scope || setting.config?.scope || null,
      config: setting.config === true || setting.config?.config === true,
      value: redactValue(`${namespace}.${key}`, value),
    });
  }
  return { count: settings.length, settings };
}

export function inspectApi(game: any, modules?: string | string[] | null) {
  const ids = targetIds(game, modules);
  const packages = ids.map(id => {
    const mod = game?.modules?.get?.(id);
    const api = mod?.api;
    const globalRef = game?.[id];
    return {
      id,
      active: !!mod?.active,
      api_type: api == null ? 'none' : Array.isArray(api) ? 'array' : typeof api,
      api_keys: objectKeys(api),
      game_global: globalRef == null ? false : typeof globalRef,
    };
  });
  return { count: packages.length, packages };
}

export function inspectSockets(game: any, modules?: string | string[] | null) {
  const ids = targetIds(game, modules);
  const socket = game?.socket;
  const rows = ids.map(id => {
    const event = `module.${id}`;
    return { id, event, listeners: socketListenerCount(socket, event) };
  });
  return {
    count: rows.length,
    sockets: rows,
    hotspots: rows.filter(row => row.listeners >= 4),
  };
}

function dottedKeysIn(root: ParentNode | null | undefined, i18n: any): string[] {
  if (!root || typeof (globalThis as any).document?.createTreeWalker !== 'function') return [];
  const found = new Set<string>();
  const walker = (globalThis as any).document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    const text = String(node.textContent || '').trim();
    if (DOTTED_I18N.test(text) && i18n?.has?.(text)) found.add(text);
    node = walker.nextNode();
  }
  return [...found].slice(0, 40);
}

export function inspectI18n(ctx: QaInspectCtx) {
  const doc = ctx.document ?? (globalThis as any).document ?? null;
  const i18n = ctx.game?.i18n;
  if (!doc) return { skipped: true, reason: 'no_document', keys: [] as string[] };
  const apps = inspectApplications(ctx).applications;
  const keys = new Set<string>();
  for (const app of apps) {
    const el =
      (app.id && doc.getElementById?.(app.id)) ||
      (app.id && doc.querySelector?.(`[id="${app.id.replace(/"/g, '')}"]`));
    for (const key of dottedKeysIn(el, i18n)) keys.add(key);
  }
  return { skipped: false, keys: [...keys] };
}

type CheckStatus = 'pass' | 'fail' | 'skip';

function checkRow(
  id: string,
  status: CheckStatus,
  evidence: Record<string, unknown>,
  target: string | null = null
) {
  const row: Record<string, unknown> = { id, status, evidence };
  if (target) row.target = target;
  return row;
}

export function runChecks(ctx: QaInspectCtx, modules?: string | string[] | null) {
  const game = ctx.game;
  const filter = normalizeFilter(modules);
  const packages = inspectPackages(game, modules);
  const canvas = inspectCanvas(ctx.canvas);
  const logs =
    modules != null
      ? runtimeDiagnostics.poll({ kinds: ['error', 'deprecation'], modules })
      : runtimeDiagnostics.poll({ kinds: ['error', 'deprecation'] });
  const i18n = inspectI18n(ctx);
  const checks: Record<string, unknown>[] = [];

  checks.push(
    checkRow('game-ready', game?.ready ? 'pass' : 'fail', { ready: !!game?.ready })
  );

  const ids = filter ? [...filter] : [];
  if (!ids.length) {
    checks.push(checkRow('package-active', 'skip', { reason: 'pass_modules_to_pin' }));
  } else {
    for (const id of ids) {
      const row = packages.modules.find(mod => mod.id.toLowerCase() === id);
      checks.push(
        checkRow(
          'package-active',
          row?.active ? 'pass' : 'fail',
          { active: !!row?.active, enabled: !!row?.enabled },
          id
        )
      );
    }
  }

  checks.push(
    checkRow('package-problems', packages.problems.length === 0 ? 'pass' : 'fail', {
      count: packages.problems.length,
      ids: packages.problems.map(row => row.id),
    })
  );

  const dirty = logs.summary.errors + logs.summary.deprecations;
  checks.push(
    checkRow('console-clean', dirty === 0 ? 'pass' : 'fail', {
      errors: logs.summary.errors,
      deprecations: logs.summary.deprecations,
      sample: logs.entries.slice(0, 5).map(entry => ({
        id: entry.id,
        kind: entry.kind,
        packageId: entry.packageId,
        message: entry.message,
        source_path: entry.source_path,
      })),
    })
  );

  if (!canvas.ready || canvas.fps == null) {
    checks.push(checkRow('fps-floor', 'skip', { reason: 'canvas_not_ready' }));
  } else {
    checks.push(
      checkRow('fps-floor', canvas.fps >= FPS_FLOOR ? 'pass' : 'fail', {
        fps: canvas.fps,
        floor: FPS_FLOOR,
      })
    );
  }

  if (i18n.skipped) {
    checks.push(checkRow('i18n-open-apps', 'skip', { reason: i18n.reason }));
  } else {
    checks.push(
      checkRow('i18n-open-apps', i18n.keys.length === 0 ? 'pass' : 'fail', {
        keys: i18n.keys,
      })
    );
  }

  const failed = checks.filter(row => row.status === 'fail').length;
  const skipped = checks.filter(row => row.status === 'skip').length;
  const passed = checks.filter(row => row.status === 'pass').length;
  return { passed, failed, skipped, checks };
}

export function inspectHealth(ctx: QaInspectCtx) {
  const game = ctx.game;
  const packages = inspectPackages(game);
  const apps = inspectApplications(ctx);
  const hooks = inspectHooks(ctx.Hooks);
  const canvas = inspectCanvas(ctx.canvas);
  const combat = inspectCombat(game);
  return {
    ready: !!game?.ready,
    world: game?.world ? { id: String(game.world.id || ''), title: String(game.world.title || '') } : null,
    user: game?.user
      ? { id: String(game.user.id || ''), name: String(game.user.name || ''), isGM: !!game.user.isGM }
      : null,
    core: String(game?.version || ''),
    system: packages.system,
    users_active: asList(game?.users).filter(user => user.active).length,
    documents: {
      actors: game?.actors?.size ?? asList(game?.actors).length,
      items: game?.items?.size ?? asList(game?.items).length,
      scenes: game?.scenes?.size ?? asList(game?.scenes).length,
      journals: game?.journal?.size ?? asList(game?.journal).length,
    },
    packages: packages.counts,
    problems: packages.problems,
    applications: apps.count,
    hooks: {
      hook_count: hooks.hook_count,
      listener_count: hooks.listener_count,
      hotspots: hooks.hotspots.slice(0, 8),
    },
    canvas,
    combat,
    diagnostics: runtimeDiagnostics.status(),
  };
}

export function qaInspect(
  options: QaInspectOptions,
  ctx: QaInspectCtx = {
    game: (globalThis as any).game,
    canvas: (globalThis as any).canvas,
    foundry: (globalThis as any).foundry,
    ui: (globalThis as any).ui,
    Hooks: (globalThis as any).Hooks,
    document: (globalThis as any).document ?? null,
  }
) {
  switch (options.action) {
    case 'packages':
      return inspectPackages(ctx.game, options.modules);
    case 'applications':
      return inspectApplications(ctx);
    case 'hooks':
      return inspectHooks(ctx.Hooks, options.hook, options.limit);
    case 'canvas':
      return inspectCanvas(ctx.canvas);
    case 'combat':
      return inspectCombat(ctx.game);
    case 'health':
      return inspectHealth(ctx);
    case 'settings':
      return inspectSettings(ctx.game, options.modules);
    case 'api':
      return inspectApi(ctx.game, options.modules);
    case 'sockets':
      return inspectSockets(ctx.game, options.modules);
    case 'check':
      return runChecks(ctx, options.modules);
    default:
      throw new Error(`Unknown qa-inspect action: ${String((options as any).action)}`);
  }
}
