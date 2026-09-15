import { MODULE_ID } from './constants.js';

export type DiagnosticKind = 'error' | 'warning' | 'info' | 'deprecation' | 'performance';
export type DiagnosticOrigin = 'core' | 'system' | 'module' | 'unknown';

export interface DiagnosticEntry {
  id: number;
  ts: string;
  kind: DiagnosticKind;
  origin: DiagnosticOrigin;
  packageId: string | null;
  packages: string[];
  message: string;
  stack: string | null;
  source: string;
  source_path: string | null;
  deprecation: boolean;
  since?: string;
  until?: string;
  count: number;
  fp: string;
}

export interface PollOptions {
  modules?: string | string[] | null;
  kinds?: DiagnosticKind[] | null;
  since_id?: number | null;
  limit?: number;
  ack?: boolean;
}

const MAX_BUFFER = 500;
const MAX_MESSAGE = 2000;
const MAX_STACK = 4000;
const DEDUPE_MS = 60_000;
const DEFAULT_KINDS: DiagnosticKind[] = ['error', 'warning', 'deprecation', 'performance'];
const PERF_RE =
  /slow (?:hook|package|render)|long task|dropped frames|low fps|performance warning|exceeded \d+\s*ms/i;
const DEPRECATION_RE = /deprecat|compatibility warning|is deprecated|will be removed/i;
const SOCKET_NOISE_RE =
  /lost connection to the server|server connection lost|server connection re-established|attempting to re-connect/i;
const RELOAD_NOISE_RE = /err_aborted|err_cache_operation|failed to load audio buffer/i;

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function formatArgs(args: unknown[]): string {
  return args
    .map(value => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) {
        return value.stack ? `${value.message}\n${value.stack}` : value.message;
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ');
}

export function stripSelfFrames(stack: string | null | undefined): string | null {
  if (!stack) return null;
  const lines = stack.split('\n').filter(line => {
    const lower = line.toLowerCase();
    return !lower.includes(`/${MODULE_ID}/`) && !lower.includes('runtime-diagnostics');
  });
  return (lines.length ? lines.join('\n') : stack).trim() || null;
}

export function extractPackageIds(text: string): string[] {
  const ids = new Set<string>();
  const hay = String(text || '');
  for (const match of hay.matchAll(/\/(?:modules|systems)\/([^/?#]+)\//gi)) {
    if (match[1] !== MODULE_ID) ids.add(match[1]);
  }
  const lead = hay.match(/^\s*\[([A-Za-z0-9._-]+)\]/) || hay.match(/^\s*([A-Za-z0-9._-]+)\s+\|/);
  if (lead && lead[1] !== MODULE_ID) ids.add(lead[1]);
  return [...ids];
}

export function sourcePathFromStack(stack: string | null): string | null {
  if (!stack) return null;
  const match = stack.match(/\/(?:modules|systems)\/([^/?#]+)\/([^:?)\s]+)/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export function summarizeEntries(entries: DiagnosticEntry[]) {
  const by_kind: Record<string, number> = {};
  const by_package: Record<string, number> = {};
  for (const entry of entries) {
    by_kind[entry.kind] = (by_kind[entry.kind] || 0) + 1;
    const key = entry.packageId || entry.origin;
    by_package[key] = (by_package[key] || 0) + 1;
  }
  return {
    by_kind,
    by_package,
    errors: by_kind.error || 0,
    warnings: by_kind.warning || 0,
    deprecations: by_kind.deprecation || 0,
    performance: by_kind.performance || 0,
  };
}

export function classifyKind(
  consoleType: string,
  text: string,
  forced?: DiagnosticKind
): DiagnosticKind {
  if (forced) return forced;
  if (DEPRECATION_RE.test(text)) return 'deprecation';
  if (PERF_RE.test(text)) return 'performance';
  if (consoleType === 'error') return 'error';
  if (consoleType === 'warn') return 'warning';
  return 'info';
}

export function originOf(packages: string[], text: string): DiagnosticOrigin {
  const hay = String(text || '');
  if (/\/systems\/[^/?#]+\//i.test(hay) || packages.some(id => hay.includes(`/systems/${id}/`))) {
    return 'system';
  }
  if (packages.length) return 'module';
  if (/\/(?:scripts|foundry|commons|client)\//i.test(hay) || /foundry\.mjs|foundry\.js/i.test(hay)) {
    return 'core';
  }
  return 'unknown';
}

export function fingerprint(kind: string, message: string, packageId: string | null): string {
  const base = `${kind}|${packageId || ''}|${message.slice(0, 240)}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) hash = (hash * 31 + base.charCodeAt(i)) | 0;
  return `${kind}:${packageId || 'core'}:${(hash >>> 0).toString(16)}`;
}

export function normalizeModuleFilter(modules?: string | string[] | null): 'all' | Set<string> {
  if (modules == null || modules === '' || modules === 'all' || modules === '*') return 'all';
  const list = (Array.isArray(modules) ? modules : [modules])
    .map(id => String(id).trim().toLowerCase())
    .filter(Boolean);
  if (!list.length || list.includes('all') || list.includes('*')) return 'all';
  return new Set(list);
}

function matchesModules(entry: DiagnosticEntry, filter: 'all' | Set<string>): boolean {
  if (filter === 'all') return true;
  const ids = new Set(entry.packages.map(id => id.toLowerCase()));
  if (entry.packageId) ids.add(entry.packageId.toLowerCase());
  if (filter.has('core') && (entry.origin === 'core' || entry.origin === 'unknown')) return true;
  for (const id of ids) {
    if (filter.has(id)) return true;
  }
  return false;
}

export class RuntimeDiagnostics {
  private buffer: DiagnosticEntry[] = [];
  private nextId = 1;
  private dropped = 0;
  private lastAckId = 0;
  private installed = false;
  private lateInstalled = false;
  private recording = false;
  private originals: Partial<Record<'error' | 'warn' | 'info' | 'log', (...args: unknown[]) => void>> =
    {};
  private compatOriginal: ((...args: unknown[]) => unknown) | null = null;
  private observers: PerformanceObserver[] = [];
  private windowHandlers: Array<{ type: string; handler: EventListener }> = [];

  ingest(partial: {
    kind?: DiagnosticKind;
    consoleType?: string;
    message: string;
    stack?: string | null;
    source?: string;
    since?: string;
    until?: string;
  }): DiagnosticEntry | null {
    const message = clip(String(partial.message || '').trim(), MAX_MESSAGE);
    if (!message) return null;
    if (SOCKET_NOISE_RE.test(message) || RELOAD_NOISE_RE.test(message)) return null;

    const stack = partial.stack ? clip(stripSelfFrames(partial.stack) || partial.stack, MAX_STACK) : null;
    const hay = `${message}\n${stack || ''}`;
    const packages = extractPackageIds(hay);

    const kind = classifyKind(partial.consoleType || 'error', hay, partial.kind);
    const origin = originOf(packages, hay);
    const packageId = packages.find(id => id !== MODULE_ID) || packages[0] || null;
    const deprecation = kind === 'deprecation' || DEPRECATION_RE.test(hay);
    const fp = fingerprint(kind, message, packageId);
    const now = Date.now();
    const dup = this.buffer.find(
      entry => entry.fp === fp && now - Date.parse(entry.ts) < DEDUPE_MS
    );
    if (dup) {
      dup.count += 1;
      dup.ts = new Date().toISOString();
      return dup;
    }

    const entry: DiagnosticEntry = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      kind,
      origin,
      packageId,
      packages,
      message,
      stack,
      source: partial.source || 'console',
      source_path: sourcePathFromStack(stack),
      deprecation,
      count: 1,
      fp,
    };
    if (partial.since) entry.since = partial.since;
    if (partial.until) entry.until = partial.until;
    this.buffer.push(entry);
    while (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift();
      this.dropped += 1;
    }
    return entry;
  }

  poll(options: PollOptions = {}): {
    entries: DiagnosticEntry[];
    next_id: number;
    dropped: number;
    returned: number;
    truncated: boolean;
    summary: ReturnType<typeof summarizeEntries>;
  } {
    const filter = normalizeModuleFilter(options.modules);
    const kinds = options.kinds?.length ? new Set(options.kinds) : new Set(DEFAULT_KINDS);
    const since = Math.max(options.since_id ?? 0, this.lastAckId);
    const limit = Math.min(Math.max(options.limit ?? 80, 1), 200);
    const matched = this.buffer.filter(entry => {
      if (entry.id <= since) return false;
      if (!kinds.has(entry.kind)) return false;
      return matchesModules(entry, filter);
    });
    const truncated = matched.length > limit;
    const entries = matched.slice(0, limit);
    if (options.ack && entries.length) {
      this.lastAckId = entries[entries.length - 1].id;
    }
    return {
      entries,
      next_id: this.nextId,
      dropped: this.dropped,
      returned: entries.length,
      truncated,
      summary: summarizeEntries(entries),
    };
  }

  status(): Record<string, unknown> {
    const byKind: Record<string, number> = {};
    const byPackage: Record<string, number> = {};
    for (const entry of this.buffer) {
      byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
      const key = entry.packageId || entry.origin;
      byPackage[key] = (byPackage[key] || 0) + 1;
    }
    let fps: number | null = null;
    try {
      const ticker = (globalThis as any).canvas?.app?.ticker;
      if (ticker && typeof ticker.FPS === 'number') fps = Math.round(ticker.FPS);
    } catch {
      fps = null;
    }
    return {
      capturing: this.installed,
      size: this.buffer.length,
      capacity: MAX_BUFFER,
      dropped: this.dropped,
      next_id: this.nextId,
      last_ack_id: this.lastAckId,
      by_kind: byKind,
      by_package: byPackage,
      fps,
    };
  }

  clear(): { cleared: number } {
    const cleared = this.buffer.length;
    this.buffer = [];
    this.dropped = 0;
    this.lastAckId = 0;
    return { cleared };
  }

  install(): void {
    if (this.installed) return;
    if (typeof console === 'undefined') return;
    this.installed = true;
    this.wrapConsole('error');
    this.wrapConsole('warn');
    this.wrapConsole('info');
    this.installWindowHandlers();
    this.installHookListener();
    this.installPerformanceObserver();
  }

  installLate(): void {
    if (this.lateInstalled) return;
    this.lateInstalled = true;
    this.wrapCompatibilityWarning();
  }

  uninstall(): void {
    (['error', 'warn', 'info'] as const).forEach(method => {
      const original = this.originals[method];
      if (original) (console as any)[method] = original;
    });
    this.originals = {};
    if (this.compatOriginal) {
      const utils = (globalThis as any).foundry?.utils;
      if (utils) utils.logCompatibilityWarning = this.compatOriginal;
      this.compatOriginal = null;
    }
    for (const { type, handler } of this.windowHandlers) {
      globalThis.removeEventListener?.(type, handler);
    }
    this.windowHandlers = [];
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    this.installed = false;
    this.lateInstalled = false;
  }

  private wrapConsole(method: 'error' | 'warn' | 'info'): void {
    const original = (console[method] as (...args: unknown[]) => void).bind(console);
    this.originals[method] = original;
    (console as any)[method] = (...args: unknown[]) => {
      original(...args);
      if (this.recording) return;
      this.recording = true;
      try {
        const errorArg = args.find(value => value instanceof Error) as Error | undefined;
        this.ingest({
          consoleType: method,
          message: formatArgs(args),
          stack: errorArg?.stack || stripSelfFrames(new Error('console').stack) || null,
          source: `console.${method}`,
        });
      } finally {
        this.recording = false;
      }
    };
  }

  private installWindowHandlers(): void {
    if (typeof globalThis.addEventListener !== 'function') return;
    const onError = ((event: ErrorEvent) => {
      this.ingest({
        consoleType: 'error',
        message: event.message || String(event.error || 'window error'),
        stack: event.error?.stack || null,
        source: 'window.error',
      });
    }) as EventListener;
    const onRejection = ((event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message =
        reason instanceof Error ? reason.message : formatArgs([reason ?? 'unhandledrejection']);
      this.ingest({
        consoleType: 'error',
        message,
        stack: reason instanceof Error ? reason.stack || null : null,
        source: 'window.unhandledrejection',
      });
    }) as EventListener;
    globalThis.addEventListener('error', onError);
    globalThis.addEventListener('unhandledrejection', onRejection);
    this.windowHandlers.push({ type: 'error', handler: onError });
    this.windowHandlers.push({ type: 'unhandledrejection', handler: onRejection });
  }

  private installHookListener(): void {
    const hooks = (globalThis as any).Hooks;
    if (!hooks || typeof hooks.on !== 'function') return;
    hooks.on('error', (location: unknown, error: unknown, data: unknown) => {
      const err = error instanceof Error ? error : null;
      this.ingest({
        consoleType: 'error',
        message: formatArgs([location, error, data]),
        stack: err?.stack || null,
        source: 'hooks.error',
      });
    });
  }

  private installPerformanceObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration < 50) continue;
          this.ingest({
            kind: 'performance',
            message: `long task ${Math.round(entry.duration)}ms ${entry.name || ''}`.trim(),
            source: 'performance.longtask',
          });
        }
      });
      observer.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
      this.observers.push(observer);
    } catch {
      // longtask is not available in every browser
    }
  }

  private wrapCompatibilityWarning(): void {
    const utils = (globalThis as any).foundry?.utils;
    if (!utils || typeof utils.logCompatibilityWarning !== 'function') return;
    const original = utils.logCompatibilityWarning.bind(utils);
    this.compatOriginal = original;
    utils.logCompatibilityWarning = (message: unknown, options: Record<string, unknown> = {}) => {
      const text = String(message ?? '');
      const payload: {
        kind: 'deprecation';
        message: string;
        stack: string | null;
        source: string;
        since?: string;
        until?: string;
      } = {
        kind: 'deprecation',
        message: text,
        stack:
          typeof options.stack === 'string'
            ? options.stack
            : stripSelfFrames(new Error('deprecation').stack),
        source: 'foundry.utils.logCompatibilityWarning',
      };
      if (options.since) payload.since = String(options.since);
      if (options.until) payload.until = String(options.until);
      this.ingest(payload);
      return original(message, options);
    };
  }
}

export const runtimeDiagnostics = new RuntimeDiagnostics();
