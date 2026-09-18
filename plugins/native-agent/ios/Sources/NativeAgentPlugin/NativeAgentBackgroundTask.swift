import Foundation
import BackgroundTasks
import Capacitor

/// Background cron/heartbeat wake via BGProcessingTask (no extra dependency).
///
/// Requirements on the HOST APP:
///   1. Info.plist → `BGTaskSchedulerPermittedIdentifiers` must contain
///      `io.t6x.nativeagent.wake`.
///   2. Signing & Capabilities → Background Modes → "Background fetch".
///
/// BGProcessing is opportunistic (the OS picks an idle window, typically
/// within a few hours, and allows ~30 min of runtime), which is the right
/// granularity for cron/heartbeat evaluation. The engine enforces its own
/// background timeouts (`agent.background_timeout` event).
enum NativeAgentBackgroundTask {

    static let taskIdentifier = "io.t6x.nativeagent.wake"

    private static let lock = NSLock()
    private static var registered = false

    /// True when the app bundle was configured for this background task id.
    /// Scheduling without the Info.plist entry raises an ObjC exception
    /// (uncatchable from Swift), so we probe the bundle first and fail
    /// gracefully with a normal Swift error instead.
    static var permissionConfigured: Bool {
        guard let ids = Bundle.main.object(
            forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers"
        ) as? [String] else {
            return false
        }
        return ids.contains(taskIdentifier)
    }

    static func schedule(intervalMinutes: Int) throws {
        guard permissionConfigured else {
            throw NSError(
                domain: "NativeAgent",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey:
                    "Info.plist is missing BGTaskSchedulerPermittedIdentifiers containing '\(taskIdentifier)' — add it (and Background Modes → Background fetch) to enable background wakes."
                ]
            )
        }
        registerIfNeeded()

        let request = BGProcessingTaskRequest(identifier: taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: TimeInterval(intervalMinutes) * 60)
        // schedule() returns false (rather than throwing) when the system
        // refuses; treat refusal as a normal error the JS caller can inspect.
        guard BGTaskScheduler.shared.schedule(request) else {
            throw NSError(
                domain: "NativeAgent",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "BGTaskScheduler refused to schedule the wake request"]
            )
        }
    }

    static func cancel() {
        BGTaskScheduler.shared.pendingRequests
            .filter { $0.taskIdentifier == taskIdentifier }
            .forEach { BGTaskScheduler.shared.cancel($0) }
    }

    // ── internals ─────────────────────────────────────────────────────

    private static func registerIfNeeded() {
        lock.lock()
        defer { lock.unlock() }
        guard !registered else { return }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { request in
            handle(task: request)
        }
        registered = true
    }

    private static func handle(task: BGProcessingTask) {
        DispatchQueue.global(qos: .utility).async {
            let ok: Bool
            do {
                if let h = NativeAgentBridge.handle() {
                    try h.handleWake(source: "ios_bg_task")
                    ok = true
                } else if let config = restoredConfig() {
                    let h = try NativeAgentHandle(config: config)
                    NativeAgentBridge.setHandle(h)
                    try h.handleWake(source: "ios_bg_task")
                    ok = true
                } else {
                    NSLog("[NativeAgent] background wake skipped: no saved init config (initialize() never ran?)")
                    ok = false
                }
            } catch {
                NSLog("[NativeAgent] background wake failed: \(error.localizedDescription)")
                ok = false
            }
            if #available(iOS 15.0, *) {
                task.setTaskCompleted(success: ok)
            } else {
                task.setTaskCompleted(hadError: !ok)
            }
        }
    }

    /// Restores the InitConfig saved by `initialize()` so a background launch
    /// (no webview alive) can still re-enter the scheduler.
    private static func restoredConfig() -> InitConfig? {
        guard let dict = UserDefaults.standard.dictionary(forKey: "mobilecron:native-agent-config"),
              let dbPath = dict["dbPath"] as? String,
              let workspacePath = dict["workspacePath"] as? String,
              let authProfilesPath = dict["authProfilesPath"] as? String
        else {
            return nil
        }
        return InitConfig(
            dbPath: dbPath,
            workspacePath: workspacePath,
            authProfilesPath: authProfilesPath,
            defaultProvider: dict["defaultProvider"] as? String,
            defaultModel: dict["defaultModel"] as? String
        )
    }
}
