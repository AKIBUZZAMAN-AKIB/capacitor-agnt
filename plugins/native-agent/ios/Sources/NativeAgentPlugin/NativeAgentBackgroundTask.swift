import BackgroundTasks
import Foundation

/// iOS half of the background-wake feature: a `BGProcessingTask` that runs
/// `NativeAgentWakeRunner` while the app is not frontmost.
///
/// ## Why `BGProcessingTask` and not `BGAppRefreshTask` / a timer / a location hack
///
///  * A cron job runs a full agent turn against an LLM, and the engine budgets
///    25 s wall clock per job — that is "minutes of work", which is what Apple
///    designed `BGProcessingTask` for (`BGAppRefreshTask` is for short refreshes,
///    and it cannot request network/power conditions).
///  * The request declares `requiresNetworkConnectivity`, so the system does not
///    spend a wake on a device with no network, and `requiresExternalPower` is
///    wired to the engine's own `scheduler_config.runOnCharging` flag instead of
///    being hard-coded.
///  * There is no API to "run later in the background" that a user cannot
///    revoke: `earliestBeginDate` is a *floor*, the system decides the real time,
///    and it stops launching tasks entirely if the user force-quits the app.
///    `getWakeStatus()` reports what the OS actually holds, not what we asked for.
///
/// ## Registration rules that this file encodes
///
///  * The launch handler must be registered before the app finishes launching,
///    which is why `scripts/configure-native.mjs` calls
///    `NativeAgentBackgroundTask.registerIfNeeded()` from
///    `didFinishLaunchingWithOptions` (the same pattern the app already used for
///    `@capacitor/background-runner`).
///  * The identifier must be listed in `BGTaskSchedulerPermittedIdentifiers`;
///    submitting or registering an identifier that is not listed fails, so both
///    are checked and reported instead of crashing.
///  * Registering the same identifier twice kills the process, so registration is
///    guarded by a process-wide flag.
///  * A `BGProcessingTask` is one-shot: the next request is submitted from inside
///    the launch handler, before the current one completes.
@objc(NativeAgentBackgroundTask)
public final class NativeAgentBackgroundTask: NSObject {

    /// Must match `AGENT_WAKE_TASK_ID` in `scripts/configure-native.mjs`, which
    /// whitelists it in `Info.plist` together with the `processing` background mode.
    public static let taskIdentifier = "io.t6x.nativeagent.wake"

    private static let lock = NSLock()
    private static var registered = false
    private static var registrationAccepted = false

    /// True when the app bundle was configured for this background task id.
    /// Scheduling without the Info.plist entry raises an uncatchable ObjC
    /// exception, so the bundle is probed first and a normal error returned.
    public static var permissionConfigured: Bool {
        guard let ids = Bundle.main.object(
            forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers"
        ) as? [String] else {
            return false
        }
        return ids.contains(taskIdentifier)
    }

    /// Registers the launch handler exactly once per process. Returns whether the
    /// scheduler accepted the identifier.
    @objc @discardableResult
    public static func registerIfNeeded() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if registered { return registrationAccepted }
        registered = true

        guard permissionConfigured else {
            registrationAccepted = false
            return false
        }
        registrationAccepted = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: taskIdentifier,
            using: nil
        ) { task in
            handle(task: task)
        }
        return registrationAccepted
    }

    /// Submits the next wake. Returns a reason instead of throwing, so the JS
    /// layer receives the same envelope Android produces.
    @discardableResult
    public static func schedule(intervalMinutes: Int, requiresCharging: Bool) -> (ok: Bool, reason: String?) {
        guard permissionConfigured else {
            return (false, "Info.plist is missing BGTaskSchedulerPermittedIdentifiers containing '\(taskIdentifier)'")
        }
        guard registerIfNeeded() else {
            return (false, "BGTaskScheduler refused to register '\(taskIdentifier)'")
        }

        let request = BGProcessingTaskRequest(identifier: taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = requiresCharging
        // iOS decides the real timing; earliestBeginDate is the floor we ask for.
        request.earliestBeginDate = Date(
            timeIntervalSinceNow: TimeInterval(max(intervalMinutes, NativeAgentWakeStore.minIntervalMinutes)) * 60
        )
        // Re-submitting the same identifier replaces the previous request, so
        // there is never more than one pending agent wake.
        do {
            try BGTaskScheduler.shared.submit(request)
            return (true, nil)
        } catch {
            return (false, "BGTaskScheduler refused the request: \(error.localizedDescription)")
        }
    }

    /// Cancels the pending wake by identifier (there is no request object to keep).
    ///
    /// Cancelling an identifier that has no pending request is a no-op, not an
    /// error, so the reported `jobCancelled: true` is a post-condition: *after this
    /// call the scheduler holds no agent wake*. It never claims a task was there.
    public static func cancel() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
    }

    /// Reads the pending request back from the scheduler — the only honest source
    /// for "is a wake armed, and when may it run".
    public static func pendingEarliestBeginDate(completion: @escaping (Date?) -> Void) {
        BGTaskScheduler.shared.getPendingTaskRequests { requests in
            let match = requests.first { $0.identifier == taskIdentifier }
            completion(match?.earliestBeginDate)
        }
    }

    // ── launch handler ───────────────────────────────────────────────────────

    private static func handle(task: BGTask) {
        // Re-arm first: a BGProcessingTask is one-shot, and iOS only runs the next
        // submission if it was queued before this one finishes.
        let store = NativeAgentWakeStore()
        _ = schedule(intervalMinutes: store.intervalMinutes, requiresCharging: store.requiresCharging)

        // The system can cut us off at any time; setTaskCompleted must be called
        // exactly once, from whichever finishes first.
        let completion = CompletedOnce()
        task.expirationHandler = {
            // The Rust call cannot be cancelled mid-flight — the engine bounds each
            // job itself (25 s wall clock) — so the honest answer here is "not
            // finished", and the next wake picks the work up again.
            completion.run { task.setTaskCompleted(success: false) }
        }

        DispatchQueue.global(qos: .utility).async {
            let outcome = NativeAgentWakeRunner.run(source: NativeAgentWakeRunner.sourceBackgroundTask)
            completion.run { task.setTaskCompleted(success: outcome.ok) }
        }
    }
}

/// `BGTask.setTaskCompleted(success:)` must be called exactly once per launch;
/// calling it twice is a programmer error, and the expiration handler can race
/// the work block.
private final class CompletedOnce {
    private let lock = NSLock()
    private var done = false

    func run(_ body: () -> Void) {
        lock.lock()
        if done {
            lock.unlock()
            return
        }
        done = true
        lock.unlock()
        body()
    }
}
