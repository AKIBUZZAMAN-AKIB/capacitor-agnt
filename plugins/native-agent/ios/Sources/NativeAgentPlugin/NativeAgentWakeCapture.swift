import Foundation

/// Turns one finished iOS wake into surfaced messages — the twin of Android's
/// `NativeWakeCapture.kt`, so both platforms fill the same store with the same
/// record shape.
///
/// The engine already did the hard part: `handle_wake(source:)` wrote one
/// `cron_runs` row per due job with `wake_source` set to exactly the string the
/// caller passed, plus `status`, `duration_ms`, `error`, `response_text` and
/// `delivered`. A wake's output is therefore read back with `listCronRuns()` and
/// selected by `wakeSource` + `startedAt >= <wake start>` — the same rows the
/// engine's own history shows, so there is no second source of truth to drift.
final class NativeAgentWakeCapture {

    /// `source` value of records produced by a wake (the pre-existing contract).
    static let surfacedSource = "background"

    private static let runScanLimit: Int64 = 200
    private static let maxTextChars = 8000
    private static let maxBodyChars = 4000

    struct Captured {
        let ran: Int
        let failed: Int
        let surfaced: Int
        let summary: String
    }

    /// Wraps the notifier for the duration of a wake so notifications the engine
    /// posts are also persisted (a notification the user dismisses otherwise
    /// leaves no trace of what the cron job produced).
    static func installRecordingNotifier(handle: NativeAgentHandle, store: NativeAgentWakeStore) {
        try? handle.setNotifier(notifier: NativeAgentWakeNotifier(store: store))
    }

    /// Puts the plain notifier back after a foreground wake.
    static func restoreDefaultNotifier(handle: NativeAgentHandle) {
        try? handle.setNotifier(notifier: NativeNotifierImpl())
    }

    static func capture(
        handle: NativeAgentHandle,
        store: NativeAgentWakeStore,
        source: String,
        startedAtMs: Int64
    ) -> Captured {
        let names = jobNames(handle: handle)

        var ran = 0
        var failed = 0
        var surfaced = 0

        let runsJson = (try? handle.listCronRuns(jobId: nil, limit: runScanLimit)) ?? "[]"
        let runs = jsonArray(runsJson)

        for run in runs {
            guard (run["wakeSource"] as? String) == source else { continue }
            let startedAt = int64(run["startedAt"])
            guard startedAt >= startedAtMs else { continue }

            let status = (run["status"] as? String) ?? "unknown"
            let jobId = normalized(run["jobId"])
            let error = normalized(run["error"])
            let text = normalized(run["responseText"])
            let body: String
            if status == "error" {
                body = error.isEmpty ? "the job failed without an error message" : error
            } else if text.isEmpty {
                body = "the job completed but the model returned no text"
            } else {
                body = text
            }

            store.append(
                source: surfacedSource,
                title: names[jobId] ?? (jobId.isEmpty ? "cron job" : jobId),
                body: String(body.prefix(maxBodyChars)),
                text: String(text.prefix(maxTextChars)),
                jobId: jobId.isEmpty ? nil : jobId,
                runId: int64(run["id"]),
                status: status,
                delivered: bool(run["delivered"]),
                at: Date(timeIntervalSince1970: Double(startedAt > 0 ? startedAt : nowMs()) / 1000)
            )
            if status == "ok" { ran += 1 } else { failed += 1 }
            surfaced += 1
        }

        let summary = surfaced == 0
            ? "no cron job was due (source: \(source))"
            : "ran \(ran) job(s), \(failed) failed (source: \(source))"
        return Captured(ran: ran, failed: failed, surfaced: surfaced, summary: summary)
    }

    /// How many cron jobs are enabled, and how many are already due, straight
    /// from `listCronJobs()` — `pendingTasks` keeps the meaning the previous
    /// generation's `getWakeStatus()` gave it: work still waiting to run.
    static func cronSummary(_ jobsJson: String) -> (enabled: Int, due: Int) {
        var enabled = 0
        var due = 0
        let now = nowMs()
        for job in jsonArray(jobsJson) {
            guard bool(job["enabled"]) == true else { continue }
            enabled += 1
            let nextRunAt = int64(job["nextRunAt"])
            if nextRunAt > 0 && nextRunAt <= now { due += 1 }
        }
        return (enabled, due)
    }

    /// jobId → job name, so a surfaced record has a human title.
    private static func jobNames(handle: NativeAgentHandle) -> [String: String] {
        var names: [String: String] = [:]
        guard let json = try? handle.listCronJobs() else { return names }
        for job in jsonArray(json) {
            let id = (job["id"] as? String) ?? ""
            let name = normalized(job["name"])
            if !id.isEmpty && !name.isEmpty { names[id] = name }
        }
        return names
    }

    // ── small JSON helpers (org.json on Android tolerates absent fields; the
    //    equivalent here keeps the two implementations symmetrical) ───────────

    private static func jsonArray(_ json: String) -> [[String: Any]] {
        guard let data = json.data(using: .utf8),
              let array = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
            return []
        }
        return array
    }

    private static func normalized(_ value: Any?) -> String {
        let text = (value as? String) ?? ""
        return text == "null" ? "" : text
    }

    private static func int64(_ value: Any?) -> Int64 {
        if let number = value as? NSNumber { return number.int64Value }
        if let text = value as? String { return Int64(text) ?? 0 }
        return 0
    }

    private static func bool(_ value: Any?) -> Bool? {
        if let flag = value as? Bool { return flag }
        if let number = value as? NSNumber { return number.intValue != 0 }
        if let text = value as? String { return text == "1" || text.lowercased() == "true" }
        return nil
    }

    private static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

/// Notifier used while a wake runs: posts the OS notification **and** records it
/// as a surfaced message. The engine stores the returned string as the
/// notification id that shows up later in the `cron.notification` event, so the
/// delegate's answer is passed through unchanged.
final class NativeAgentWakeNotifier: NativeNotifier {
    private let store: NativeAgentWakeStore
    private let delegate: NativeNotifier

    init(store: NativeAgentWakeStore, delegate: NativeNotifier = NativeNotifierImpl()) {
        self.store = store
        self.delegate = delegate
    }

    func sendNotification(title: String, body: String, dataJson: String) -> String {
        let result = delegate.sendNotification(title: title, body: body, dataJson: dataJson)
        var jobId: String?
        var deliveryMode: String?
        if let data = dataJson.data(using: .utf8),
           let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            jobId = (json["jobId"] as? String)?.isEmpty == false ? json["jobId"] as? String : nil
            deliveryMode = (json["deliveryMode"] as? String)?.isEmpty == false ? json["deliveryMode"] as? String : nil
        }
        store.append(source: "notification", title: title, body: body, jobId: jobId, status: deliveryMode)
        return result
    }
}
