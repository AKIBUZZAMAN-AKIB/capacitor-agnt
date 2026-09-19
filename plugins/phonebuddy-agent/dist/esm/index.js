import { registerPlugin } from '@capacitor/core';
/**
 * PhoneBuddy agent engine. Registered natively as `PhoneBuddyAgent` on Android
 * and iOS; on the web it falls back to {@link ./web} which reports
 * `available: false` instead of pretending to run.
 */
export const PhoneBuddy = registerPlugin('PhoneBuddyAgent', {
    // Lazy so the web bundle does not pull in the native stub on Android/iOS.
    web: () => import('./web').then((m) => new m.PhoneBuddyWeb()),
});
export * from './definitions';
//# sourceMappingURL=index.js.map