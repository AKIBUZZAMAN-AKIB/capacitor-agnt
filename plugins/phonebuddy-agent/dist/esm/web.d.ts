import { WebPlugin } from '@capacitor/core';
import type { PhoneBuddyAgentPlugin, PhoneBuddyAvailability, PhoneBuddyChatOptions, PhoneBuddyChatResult, PhoneBuddyInitializeOptions, PhoneBuddyInitializeResult, PhoneBuddyLoadSurfacedOptions, PhoneBuddySurfacedResult, PhoneBuddyToggleResult, PhoneBuddyWakeOptions, PhoneBuddyWakeResult, PhoneBuddyWakeStatus } from './definitions';
/**
 * Web has no Rust engine and no OS scheduler, so every call answers honestly
 * instead of throwing where the UI expects a result object:
 *  * `checkAvailability()` resolves `available: false` (never rejects — the same
 *    guarantee the native probe gives on an unsupported ABI);
 *  * the wake APIs resolve the "not scheduled" envelope with a reason;
 *  * the surfaced-message APIs resolve empty (nothing was ever recorded).
 */
export declare class PhoneBuddyWeb extends WebPlugin implements PhoneBuddyAgentPlugin {
    checkAvailability(): Promise<PhoneBuddyAvailability>;
    initialize(_options: PhoneBuddyInitializeOptions): Promise<PhoneBuddyInitializeResult>;
    shutdown(): Promise<void>;
    sendMessage(_options: PhoneBuddyChatOptions): Promise<PhoneBuddyChatResult>;
    abort(_options: {
        sessionId?: string;
    }): Promise<void>;
    listSessions(): Promise<{
        sessionsJson: string;
    }>;
    getSession(_options: {
        sessionId: string;
    }): Promise<{
        sessionJson: string;
    }>;
    deleteSession(_options: {
        sessionId: string;
    }): Promise<{
        deleted: boolean;
    }>;
    setHostTools(_options: {
        toolsJson: string;
    }): Promise<PhoneBuddyToggleResult>;
    hostToolResult(_options: {
        callId: string;
        ok: boolean;
        output: string;
    }): Promise<PhoneBuddyToggleResult>;
    scheduleBackgroundWakes(options?: PhoneBuddyWakeOptions): Promise<PhoneBuddyWakeResult>;
    cancelBackgroundWakes(): Promise<PhoneBuddyWakeResult>;
    getWakeStatus(): Promise<PhoneBuddyWakeStatus>;
    handleWake(options?: {
        source?: string;
    }): Promise<{
        ran: number;
        summary: string;
        engineGeneration: string;
    }>;
    loadSurfacedMessages(_options?: PhoneBuddyLoadSurfacedOptions): Promise<PhoneBuddySurfacedResult>;
    clearSurfacedMessages(): Promise<{
        cleared: number;
        engineGeneration: string;
    }>;
}
//# sourceMappingURL=web.d.ts.map