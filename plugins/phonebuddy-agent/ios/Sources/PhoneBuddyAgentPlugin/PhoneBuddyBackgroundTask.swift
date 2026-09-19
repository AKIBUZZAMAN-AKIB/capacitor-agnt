import BackgroundTasks
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// iOS half of the background-wake feature (the Android half is
/// `PhoneBuddyWakeService`).
///
/// The engine expects the *host* to own OS scheduling: its scheduler tool
/// persists tasks and fires a `scheduler_registered` host event; everything else
/// is the platform's job. On iOS that platform piece is `BGTaskScheduler` +
/// `BGProcessingTask`, registered here with the identifier that
/// `scripts/configure-native.mjs` whitelists in `Info.plist`
/// (`BGTaskSchedulerPermittedIdentifiers`) together with the `processing`
/// background mode.
///
/// API notes — each mirrors a bug found in the older agent generation's Swift:
///  * `BGTaskScheduler` has no `schedule() -> Bool`; submission is
///    `try submit(request)` and throws;
///  * cancellation is by identifier (`cancel(taskRequestWithIdentifier:)`), there
///    is no synchronous `pendingRequests` property;
///  * the closure receives a `BGTask` that must be downcast (`as? BGProcessingTask`);
///  * completion is `setTaskCompleted(success:)` — `hadError:` does not exist.
@objc public final class PhoneBuddyBackgroundTask: NSObject {

    /// Must match the identifier whitelisted in Info.plist (see AGENT/PHONE BUDDY
    /// constants in scripts/configure-native.mjs).
    public static let taskIdentifier = "io.t6x.phonebuddy.wake"

    /// Set by the plugin on `load()`; runs one wake and reports its summary.
    public static var onWake: (() -> String)?

    private static var registered = false

    /// Registers the BGProcessingTask handler exactly once per process.
    public static func registerIfNeeded() {
        guard !registered else { return }
        registered = true
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            guard let processing = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(processing)
        }
    }

    private static func handle(_ task: BGProcessingTask) {
        // Re-arm first: a BGProcessingTask is one-shot, and iOS only runs the
        // next submission if it was queued before this one finished.
        _ = schedule(intervalMinutes: PhoneBuddyWakeStore.intervalMinutes)
        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }
        let summary = onWake?() ?? "no wake handler is installed"
        PhoneBuddyWakeStore.recordWake(source: "bgtask", summary: summary)
        task.setTaskCompleted(success: true)
    }

    /// Submits the next wake. Returns false (with a reason) instead of throwing so
    /// the JS side always gets the same envelope Android produces.
    @discardableResult
    public static func schedule(intervalMinutes: Int) -> (ok: Bool, reason: String?) {
        registerIfNeeded()
        let request = BGProcessingTaskRequest(identifier: taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        // iOS decides the real timing; earliestBeginDate is the floor we ask for.
        request.earliestBeginDate = Date(timeIntervalSinceNow: TimeInterval(max(intervalMinutes, 15) * 60))
        do {
            try BGTaskScheduler.shared.submit(request)
            return (true, nil)
        } catch {
            return (false, "BGTaskScheduler rejected the request: \(error.localizedDescription)")
        }
    }

    /// Cancels the pending wake by identifier (there is no request object to keep).
    @discardableResult
    public static func cancel() -> Bool {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
        return true
    }
}

/// Persistence shared by the BGTask handler and the plugin (the iOS mirror of
/// Android's `PhoneBuddyStore`).
public enum PhoneBuddyWakeStore {
    private static let intervalKey = "phonebuddy.wake.intervalMinutes"
    private static let lastWakeAtKey = "phonebuddy.wake.lastAt"
    private static let lastWakeSourceKey = "phonebuddy.wake.lastSource"
    private static let lastWakeSummaryKey = "phonebuddy.wake.lastSummary"
    private static let engineConfigKey = "phonebuddy.engine.config"

    public static var intervalMinutes: Int {
        get {
            let stored = UserDefaults.standard.integer(forKey: intervalKey)
            return stored > 0 ? stored : 30
        }
        set { UserDefaults.standard.set(newValue, forKey: intervalKey) }
    }

    public static var engineConfigJson: String? {
        get { UserDefaults.standard.string(forKey: engineConfigKey) }
        set { UserDefaults.standard.set(newValue, forKey: engineConfigKey) }
    }

    public static func recordWake(source: String, summary: String) {
        let defaults = UserDefaults.standard
        defaults.set(source, forKey: lastWakeSourceKey)
        defaults.set(summary, forKey: lastWakeSummaryKey)
        defaults.set(ISO8601DateFormatter().string(from: Date()), forKey: lastWakeAtKey)
    }

    public static var lastWakeAt: String? { UserDefaults.standard.string(forKey: lastWakeAtKey) }
    public static var lastWakeSource: String? { UserDefaults.standard.string(forKey: lastWakeSourceKey) }
    public static var lastWakeSummary: String? { UserDefaults.standard.string(forKey: lastWakeSummaryKey) }
}
