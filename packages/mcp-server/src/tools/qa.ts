import { z } from 'zod';
import { FoundryClient } from '../foundry-client.js';
import { Logger } from '../logger.js';

export interface QaToolsOptions {
  foundryClient: FoundryClient;
  logger: Logger;
}

const kinds = z.enum(['error', 'warning', 'info', 'deprecation', 'performance']);
const modulesFilter = z.union([z.string(), z.array(z.string()), z.null()]).optional();

export class QaTools {
  private foundryClient: FoundryClient;
  private logger: Logger;

  constructor({ foundryClient, logger }: QaToolsOptions) {
    this.foundryClient = foundryClient;
    this.logger = logger.child({ component: 'QaTools' });
  }

  getToolDefinitions() {
    return [
      {
        name: 'qa-poll',
        description:
          'Poll captured Foundry console errors, warnings, deprecation, and performance. Returns entries plus summary counts and source_path. modules: all, core, one id, or an id list. ack:true after a QA round so the next poll is a delta to fix.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['poll', 'status', 'clear'],
              description: 'poll (default), status, or clear',
            },
            modules: {
              description: 'all (default), core, one id, or an id list',
              anyOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
                { type: 'null' },
              ],
            },
            kinds: {
              type: 'array',
              description: 'error, warning, info, deprecation, performance',
              items: {
                type: 'string',
                enum: ['error', 'warning', 'info', 'deprecation', 'performance'],
              },
            },
            since_id: { type: 'number', description: 'Only entries with id greater than this' },
            limit: { type: 'number', description: 'Max entries (default 80, max 200)' },
            ack: { type: 'boolean', description: 'Mark returned entries as seen' },
          },
        },
      },
      {
        name: 'qa-inspect',
        description:
          'Read-only QA snapshot. action: packages, applications, hooks, canvas, combat, health, settings, api, sockets, or check.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'packages',
                'applications',
                'hooks',
                'canvas',
                'combat',
                'health',
                'settings',
                'api',
                'sockets',
                'check',
              ],
              description: 'Which snapshot or check pack to run',
            },
            modules: {
              description: 'packages: all, one id, or an id list',
              anyOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
                { type: 'null' },
              ],
            },
            hook: { type: 'string', description: 'hooks: one hook name' },
            limit: { type: 'number', description: 'hooks: max rows (default 30, max 100)' },
          },
          required: ['action'],
        },
      },
    ];
  }

  async handleQaPoll(args: any): Promise<any> {
    const parsed = z
      .object({
        action: z.enum(['poll', 'status', 'clear']).default('poll'),
        modules: modulesFilter,
        kinds: z.array(kinds).optional(),
        since_id: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        ack: z.boolean().optional(),
      })
      .parse(args ?? {});
    this.logger.info('qa-poll', { action: parsed.action, modules: parsed.modules });
    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.qa-poll', parsed);
      return { success: true, ...result };
    } catch (error) {
      this.logger.error('qa-poll failed', error);
      throw new Error(`qa-poll failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async handleQaInspect(args: any): Promise<any> {
    const parsed = z
      .object({
        action: z.enum([
          'packages',
          'applications',
          'hooks',
          'canvas',
          'combat',
          'health',
          'settings',
          'api',
          'sockets',
          'check',
        ]),
        modules: modulesFilter,
        hook: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .parse(args ?? {});
    this.logger.info('qa-inspect', { action: parsed.action });
    try {
      const result = await this.foundryClient.query('foundry-mcp-bridge.qa-inspect', parsed);
      return { success: true, ...result };
    } catch (error) {
      this.logger.error('qa-inspect failed', error);
      throw new Error(
        `qa-inspect failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
