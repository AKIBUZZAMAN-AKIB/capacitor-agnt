import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runtime contract of the five wake APIs, exercised through the REAL bridge with
// a stubbed native plugin. tests/agent-api.test.ts proves the native sources are
// wired correctly; this file proves the behaviour the JS caller actually gets:
//   * the interval is clamped before it reaches the OS (Android floors at 15 min)
//   * a native answer is spread through, so `intervalMinutes` is what the OS
//     granted rather than a re-echo of the request
//   * a native failure resolves as data (`supported:false` + reason +
//     alternative) instead of rejecting
//   * the surfaced inbox is asked for with the configured limit/read policy

const nativeAgent = vi.hoisted(() => ({
  scheduleBackgroundWakes: vi.fn(),
  cancelBackgroundWakes: vi.fn(),
  getWakeStatus: vi.fn(),
  loadSurfacedMessages: vi.fn(),
  clearSurfacedMessages: vi.fn(),
  handleWake: vi.fn(),
}));

vi.mock('capacitor-native-agent', () => ({ NativeAgent: nativeAgent }));

// Keep every real export (WebPlugin, registerPlugin, ...) and only force the
// bridge's `isNative`/platform detection, which is what gates the agent façade.
vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => true, getPlatform: () => 'android' },
  };
});

const config = JSON.parse(readFileSync(new URL('../app.config.json', import.meta.url), 'utf8'));

/**
 * The bridge does not export the façade: it installs it as `window.NativeKit`
 * (and `window` is this global in the test shim), so the tests read it back from
 * there — the same object a real page would use.
 */
let agent: any;

beforeAll(async () => {
  const globals: Record<string, unknown> = {
    __NATIVEKIT_CONFIG__: config,
    window: globalThis,
    location: new URL('https://shell.test/index.html'),
    navigator: {},
    document: { readyState: 'complete', addEventListener: () => undefined },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  await import('../bridge/nativekit');
  agent = (globalThis as any).NativeKit.agent;
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent wakes — the bridge clamps, reports and never rejects', () => {
  it('floors a below-minimum request before it reaches the OS', async () => {
    nativeAgent.scheduleBackgroundWakes.mockResolvedValue({
      jobScheduled: true,
      intervalMinutes: 15,
      mechanism: 'WorkManager PeriodicWorkRequest',
    });

    const result: any = await agent.scheduleBackgroundWakes(5);

    expect(nativeAgent.scheduleBackgroundWakes).toHaveBeenCalledWith({ intervalMinutes: 15 });
    expect(result.supported).toBe(true);
    // the native answer wins: 15 is the granted interval, not 5
    expect(result.intervalMinutes).toBe(15);
    expect(result.jobScheduled).toBe(true);
    expect(result.mechanism).toBe('WorkManager PeriodicWorkRequest');
  });

  it('uses the configured interval when the caller does not pass one', async () => {
    nativeAgent.scheduleBackgroundWakes.mockResolvedValue({ jobScheduled: true, intervalMinutes: 30 });

    await agent.scheduleBackgroundWakes();

    expect(nativeAgent.scheduleBackgroundWakes).toHaveBeenCalledWith({
      intervalMinutes: config.agent.wakeIntervalMinutes,
    });
  });

  it('caps an absurd request instead of handing it to the OS', async () => {
    nativeAgent.scheduleBackgroundWakes.mockResolvedValue({ jobScheduled: true, intervalMinutes: 1440 });

    await agent.scheduleBackgroundWakes(99_999);

    expect(nativeAgent.scheduleBackgroundWakes).toHaveBeenCalledWith({ intervalMinutes: 1440 });
  });

  it('turns a native failure into data, not a rejection', async () => {
    nativeAgent.scheduleBackgroundWakes.mockRejectedValue(new Error('WorkManager refused the request'));

    const result: any = await agent.scheduleBackgroundWakes(30);

    expect(result.supported).toBe(false);
    expect(result.jobScheduled).toBe(false);
    expect(result.reason).toContain('WorkManager refused the request');
    expect(result.alternative).toBeTruthy();
  });

  it('passes cancel/status/clear through and keeps the native fields', async () => {
    nativeAgent.cancelBackgroundWakes.mockResolvedValue({ jobScheduled: false, jobCancelled: true });
    nativeAgent.getWakeStatus.mockResolvedValue({ jobScheduled: true, lastWakeRan: 2, pendingTasks: 1 });
    nativeAgent.clearSurfacedMessages.mockResolvedValue({ cleared: 3 });

    const cancelled: any = await agent.cancelBackgroundWakes();
    const status: any = await agent.getWakeStatus();
    const cleared: any = await agent.clearSurfacedMessages();

    expect(cancelled).toMatchObject({ supported: true, jobCancelled: true });
    expect(status).toMatchObject({ supported: true, lastWakeRan: 2, pendingTasks: 1 });
    expect(cleared).toMatchObject({ supported: true, cleared: 3 });
  });

  it('asks the inbox for exactly the configured page and read policy', async () => {
    nativeAgent.loadSurfacedMessages.mockResolvedValue({ messagesJson: '[]', count: 0, unread: 0 });

    const first: any = await agent.loadSurfacedMessages();
    const second: any = await agent.loadSurfacedMessages(2);

    expect(nativeAgent.loadSurfacedMessages).toHaveBeenNthCalledWith(1, {
      limit: config.agent.surfacedLimit,
      markRead: config.agent.markSurfacedRead,
    });
    expect(nativeAgent.loadSurfacedMessages).toHaveBeenNthCalledWith(2, { limit: 2, markRead: config.agent.markSurfacedRead });
    expect(first.supported).toBe(true);
    expect(second.supported).toBe(true);
  });

  it('survives an unreachable inbox as well', async () => {
    nativeAgent.loadSurfacedMessages.mockRejectedValue(new Error('plugin not initialized'));

    const result: any = await agent.loadSurfacedMessages(10);

    expect(result.supported).toBe(false);
    expect(result.messagesJson).toBe('[]');
    expect(result.count).toBe(0);
    expect(result.reason).toContain('plugin not initialized');
  });

  it('routes a foreground catch-up wake through the same native method', async () => {
    nativeAgent.handleWake.mockResolvedValue({ ran: 1, failed: 0, surfaced: 1, summary: 'ran 1 job(s)' });

    const result: any = await agent.handleWake('manual_demo');

    expect(nativeAgent.handleWake).toHaveBeenCalledWith({ source: 'manual_demo' });
    expect(result).toMatchObject({ ran: 1, surfaced: 1 });
  });

  it('defaults the wake source when the caller omits it', async () => {
    nativeAgent.handleWake.mockResolvedValue({ ran: 0, failed: 0, surfaced: 0, summary: 'no cron job was due' });

    await agent.handleWake();

    expect(nativeAgent.handleWake).toHaveBeenCalledWith({ source: 'manual' });
  });
});
