import type { PhoneBuddyAgentPlugin } from './definitions';
/**
 * PhoneBuddy agent engine. Registered natively as `PhoneBuddyAgent` on Android
 * and iOS; on the web it falls back to {@link ./web} which reports
 * `available: false` instead of pretending to run.
 */
export declare const PhoneBuddy: PhoneBuddyAgentPlugin;
export * from './definitions';
//# sourceMappingURL=index.d.ts.map