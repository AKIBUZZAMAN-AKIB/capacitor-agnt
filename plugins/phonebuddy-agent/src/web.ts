import { WebPlugin } from '@capacitor/core';
import type {
  PhoneBuddyAgentPlugin,
  PhoneBuddyAvailability,
  PhoneBuddyChatOptions,
  PhoneBuddyChatResult,
  PhoneBuddyInitializeOptions,
  PhoneBuddyInitializeResult,
  PhoneBuddyLoadSurfacedOptions,
  PhoneBuddySurfacedResult,
  PhoneBuddyToggleResult,
  PhoneBuddyWakeOptions,
  PhoneBuddyWakeResult,
  PhoneBuddyWakeStatus,
} from './definitions';

const ENGINE_GENERATION = 'phonebuddy-0.2.0';

/**
 * Web has no Rust engine and no OS scheduler, so every call answers honestly
 * instead of throwing where the UI expects a result object:
 *  * `checkAvailability()` resolves `available: false` (never rejects — the same
 *    guarantee the native probe gives on an unsupported ABI);
 *  * the wake APIs resolve the "not scheduled" envelope with a reason;
 *  * the surfaced-message APIs resolve empty (nothing was ever recorded).
 */
export class PhoneBuddyWeb extends WebPlugin implements PhoneBuddyAgentPlugin {
  async checkAvailability(): Promise<PhoneBuddyAvailability> {
    return {
      abi: 'web',
      is64Bit: false,
      available: false,
      reason: 'The PhoneBuddy engine is a native library; the web build has no agent engine.',
      engineGeneration: ENGINE_GENERATION,
    };
  }

  async initialize(_options: PhoneBuddyInitializeOptions): Promise<PhoneBuddyInitializeResult> {
    throw this.unavailable('The PhoneBuddy engine is only available in the native app.');
  }

  async shutdown(): Promise<void> {
    return;
  }

  async sendMessage(_options: PhoneBuddyChatOptions): Promise<PhoneBuddyChatResult> {
    throw this.unavailable('The PhoneBuddy engine is only available in the native app.');
  }

  async abort(_options: { sessionId?: string }): Promise<void> {
    return;
  }

  async listSessions(): Promise<{ sessionsJson: string }> {
    return { sessionsJson: '[]' };
  }

  async getSession(_options: { sessionId: string }): Promise<{ sessionJson: string }> {
    return { sessionJson: 'null' };
  }

  async deleteSession(_options: { sessionId: string }): Promise<{ deleted: boolean }> {
    return { deleted: false };
  }

  async setHostTools(_options: { toolsJson: string }): Promise<PhoneBuddyToggleResult> {
    return { ok: false, engineGeneration: ENGINE_GENERATION, reason: 'no native engine on the web build' };
  }

  async hostToolResult(_options: { callId: string; ok: boolean; output: string }): Promise<PhoneBuddyToggleResult> {
    return { ok: false, engineGeneration: ENGINE_GENERATION, reason: 'no native engine on the web build' };
  }

  async scheduleBackgroundWakes(options?: PhoneBuddyWakeOptions): Promise<PhoneBuddyWakeResult> {
    return {
      jobScheduled: false,
      intervalMinutes: options?.intervalMinutes ?? 30,
      engineGeneration: ENGINE_GENERATION,
      reason: 'Web builds cannot schedule OS background wakes.',
    };
  }

  async cancelBackgroundWakes(): Promise<PhoneBuddyWakeResult> {
    return { jobScheduled: false, intervalMinutes: 0, engineGeneration: ENGINE_GENERATION, reason: 'nothing was scheduled' };
  }

  async getWakeStatus(): Promise<PhoneBuddyWakeStatus> {
    return { jobScheduled: false, intervalMinutes: 0, pendingTasks: 0, engineGeneration: ENGINE_GENERATION };
  }

  async handleWake(options?: { source?: string }): Promise<{ ran: number; summary: string; engineGeneration: string }> {
    return {
      ran: 0,
      summary: `no native engine (source: ${options?.source ?? 'manual'})`,
      engineGeneration: ENGINE_GENERATION,
    };
  }

  async loadSurfacedMessages(_options?: PhoneBuddyLoadSurfacedOptions): Promise<PhoneBuddySurfacedResult> {
    return { messagesJson: '[]', count: 0, unread: 0, engineGeneration: ENGINE_GENERATION };
  }

  async clearSurfacedMessages(): Promise<{ cleared: number; engineGeneration: string }> {
    return { cleared: 0, engineGeneration: ENGINE_GENERATION };
  }
}
