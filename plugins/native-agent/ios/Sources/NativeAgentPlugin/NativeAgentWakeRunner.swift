import Foundation

/// The cold-start wake path on iOS: rebuild the engine from the persisted
/// config, run every due cron job, turn the results into surfaced messages, and
/// report — the twin of Android's `NativeWakeRunner.kt`.
///
/// This runs inside the `BGProcessingTask` launch handler, i.e. in a process the
/// system may have started with no WebView, no Capacitor bridge and no
/// in-memory handle. The only durable inputs are the config path `initialize()`
/// recorded and the engine's own SQLite file; the only durable outputs are the
/// engine's `cron_runs` rows, the OS notifications, the surfaced store and the
/// telemetry `getWakeStatus()` reads.
///
/// It never throws and never crashes: a wake that fails must not take the
/// process down (and must not produce a crash log the App Store review sees).
public enum NativeAgentWakeRunner {

    /// `wake_source` used by OS-initiated wakes; also what `wakeSource` reports.
    public static let sourceBackgroundTask = "ios-bg-task"

    public struct Outcome {
        public let ok: Bool
        public let ran: Int
        public let failed: Int
        public let summary: String
    }

    /// The handle of the wake currently in flight, if any.
    ///
    /// `run` blocks its thread inside Rust, so the only way to stop it from
    /// outside is to raise the engine's own abort flag. `handleWake` checks that
    /// flag between cron jobs, so aborting makes the loop return cleanly at the
    /// next boundary — the job in flight still finalizes its own `cron_runs`
    /// row, and everything untouched stays due for the next wake.
    private static let activeHandleLock = NSLock()
    private static var activeHandle: NativeAgentHandle?

    /// Ask the in-flight wake to stop at the next safe point.
    ///
    /// Called from the `BGProcessingTask` expiration handler. Before this the
    /// handler could only report failure and walk away while Rust kept running
    /// on a background thread — burning the battery the expiration exists to
    /// protect, and still writing rows after iOS considered the task over.
    ///
    /// Safe to call when nothing is running, and safe to call twice.
    public static func requestCancel() {
        activeHandleLock.lock()
        let handle = activeHandle
        activeHandleLock.unlock()
        // A fresh handle is built for every wake, so raising the flag here can
        // never leak into the next one.
        try? handle?.abort()
    }

    /// Runs one wake. Synchronous and blocking (the Rust FFI blocks its calling
    /// thread), so callers hand it to a background queue.
    public static func run(source: String) -> Outcome {
        let store = NativeAgentWakeStore()
        let startedAtMs = Int64(Date().timeIntervalSince1970 * 1000)

        guard let configPath = store.engineConfigPath else {
            let summary = "engine config was not found — call NativeKit.agent.initialize() so a wake has something to restore"
            store.recordWake(source: source, summary: summary, ran: 0, ok: false)
            return Outcome(ok: false, ran: 0, failed: 0, summary: summary)
        }

        do {
            let handle = try createHandleFromPersistedConfig(configPath: configPath)
            activeHandleLock.lock()
            activeHandle = handle
            activeHandleLock.unlock()
            defer {
                activeHandleLock.lock()
                activeHandle = nil
                activeHandleLock.unlock()
            }
            NativeAgentWakeCapture.installRecordingNotifier(handle: handle, store: store)
            // Same provider the foreground wires in initialize(); without it the
            // engine's memory tools answer "Memory provider not configured".
            if let provider = MemoryProviderImpl.makeIfAvailable() {
                try handle.setMemoryProvider(provider: provider)
            }

            try handle.handleWake(source: source)

            let captured = NativeAgentWakeCapture.capture(
                handle: handle,
                store: store,
                source: source,
                startedAtMs: startedAtMs
            )
            store.recordWake(source: source, summary: captured.summary, ran: captured.ran, ok: true)
            return Outcome(ok: true, ran: captured.ran, failed: captured.failed, summary: captured.summary)
        } catch {
            let summary = "wake failed: \(error.localizedDescription)"
            store.recordWake(source: source, summary: summary, ran: 0, ok: false)
            return Outcome(ok: false, ran: 0, failed: 0, summary: summary)
        }
    }
}
