import { describe, expect, it, vi } from 'vitest';
import { QaTools } from './qa.js';

function makeTools(query: ReturnType<typeof vi.fn>) {
  return new QaTools({
    foundryClient: { query } as any,
    logger: { child: () => ({ info: vi.fn(), error: vi.fn() }) } as any,
  });
}

describe('QaTools', () => {
  it('qa-poll forwards filters', async () => {
    const query = vi.fn().mockResolvedValue({ returned: 1 });
    const result = await makeTools(query).handleQaPoll({
      modules: ['core', 'ose-reforged'],
      kinds: ['error', 'deprecation'],
      ack: true,
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.qa-poll', {
      action: 'poll',
      modules: ['core', 'ose-reforged'],
      kinds: ['error', 'deprecation'],
      ack: true,
    });
    expect(result.success).toBe(true);
    expect(result.returned).toBe(1);
  });

  it('qa-inspect forwards action', async () => {
    const query = vi.fn().mockResolvedValue({ counts: { problems: 1 } });
    const result = await makeTools(query).handleQaInspect({
      action: 'packages',
      modules: ['ui-mod'],
    });
    expect(query).toHaveBeenCalledWith('foundry-mcp-bridge.qa-inspect', {
      action: 'packages',
      modules: ['ui-mod'],
    });
    expect(result.success).toBe(true);
  });
});
