import { registerPlugin } from '@capacitor/core';
import type { PhoneBuddyAgentPlugin } from './definitions';

/**
 * PhoneBuddy agent engine. Registered natively as `PhoneBuddyAgent` on Android
 * and iOS; on the web it falls back to {@link ./web} which reports
 * `available: false` instead of pretending to run.
 */
export const PhoneBuddy = registerPlugin<PhoneBuddyAgentPlugin>('PhoneBuddyAgent', {
  // Lazy so the web bundle does not pull in the native stub on Android/iOS.
  web: () => import('./web').then((m) => new m.PhoneBuddyWeb()),
});

export * from './definitions';
