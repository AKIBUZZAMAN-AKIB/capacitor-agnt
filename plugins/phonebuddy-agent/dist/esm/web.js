import { WebPlugin } from '@capacitor/core';
const ENGINE_GENERATION = 'phonebuddy-0.2.0';
/**
 * Web has no Rust engine and no OS scheduler, so every call answers honestly
 * instead of throwing where the UI expects a result object:
 *  * `checkAvailability()` resolves `available: false` (never rejects — the same
 *    guarantee the native probe gives on an unsupported ABI);
 *  * the wake APIs resolve the "not scheduled" envelope with a reason;
 *  * the surfaced-message APIs resolve empty (nothing was ever recorded).
 */
export class PhoneBuddyWeb extends WebPlugin {
    async checkAvailability() {
        return {
            abi: 'web',
            is64Bit: false,
            available: false,
            reason: 'The PhoneBuddy engine is a native library; the web build has no agent engine.',
            engineGeneration: ENGINE_GENERATION,
        };
    }
    async initialize(_options) {
        throw this.unavailable('The PhoneBuddy engine is only available in the native app.');
    }
    async shutdown() {
        return;
    }
    async sendMessage(_options) {
        throw this.unavailable('The PhoneBuddy engine is only available in the native app.');
    }
    async abort(_options) {
        return;
    }
    async listSessions() {
        return { sessionsJson: '[]' };
    }
    async getSession(_options) {
        return { sessionJson: 'null' };
    }
    async deleteSession(_options) {
        return { deleted: false };
    }
    async setHostTools(_options) {
        return { ok: false, engineGeneration: ENGINE_GENERATION, reason: 'no native engine on the web build' };
    }
    async hostToolResult(_options) {
        return { ok: false, engineGeneration: ENGINE_GENERATION, reason: 'no native engine on the web build' };
    }
    async scheduleBackgroundWakes(options) {
        return {
            jobScheduled: false,
            intervalMinutes: options?.intervalMinutes ?? 30,
            engineGeneration: ENGINE_GENERATION,
            reason: 'Web builds cannot schedule OS background wakes.',
        };
    }
    async cancelBackgroundWakes() {
        return { jobScheduled: false, intervalMinutes: 0, engineGeneration: ENGINE_GENERATION, reason: 'nothing was scheduled' };
    }
    async getWakeStatus() {
        return { jobScheduled: false, intervalMinutes: 0, pendingTasks: 0, engineGeneration: ENGINE_GENERATION };
    }
    async handleWake(options) {
        return {
            ran: 0,
            summary: `no native engine (source: ${options?.source ?? 'manual'})`,
            engineGeneration: ENGINE_GENERATION,
        };
    }
    async loadSurfacedMessages(_options) {
        return { messagesJson: '[]', count: 0, unread: 0, engineGeneration: ENGINE_GENERATION };
    }
    async clearSurfacedMessages() {
        return { cleared: 0, engineGeneration: ENGINE_GENERATION };
    }
}
//# sourceMappingURL=web.js.map