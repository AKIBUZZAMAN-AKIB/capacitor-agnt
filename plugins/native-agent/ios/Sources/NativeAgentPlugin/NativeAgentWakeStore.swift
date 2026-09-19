import Foundation

/// Durable store for everything an iOS background wake produced, plus its
/// telemetry — the twin of Android's `NativeWakeStore.kt`.
///
/// Same file name (`surfaced.json`), same record shape, same cap, so
/// `loadSurfacedMessages()` answers identically on both platforms. It is written
/// from three places that can run concurrently (the plugin in the foreground,
/// the BGTask launch handler, and the notifier callback inside a wake), so every
/// mutation is serialised through `lock`.
///
/// `BGTaskScheduler` hands the app a launch handler in a process with no WebView
/// and no in-memory engine handle, so the store also owns the two pieces of
/// state that make a cold wake possible: the path of the engine config
/// `initialize()` persisted, and the interval/power requirements the OS was
/// asked for (needed to re-arm the next task from inside the launch handler).
public final class NativeAgentWakeStore {

    public static let directoryName = "native-agent-wakes"
    public static let fileName = "surfaced.json"
    public static let maxRecords = 500

    /// iOS decides when a `BGProcessingTask` runs; `earliestBeginDate` is the
    /// floor the app asks for. 15 minutes keeps both platforms describing their
    /// floor the same way (Android's WorkManager minimum).
    public static let minIntervalMinutes = 15
    public static let defaultIntervalMinutes = 30

    /// Capacitor Preferences key the plugin writes the engine config path into.
    public static let configPathKey = "mobilecron:native-agent-config-path"

    private static let intervalKey = "nativeAgent.wake.intervalMinutes"
    private static let chargingKey = "nativeAgent.wake.requiresCharging"
    private static let lastWakeAtKey = "nativeAgent.wake.lastAt"
    private static let lastWakeSourceKey = "nativeAgent.wake.lastSource"
    private static let lastWakeSummaryKey = "nativeAgent.wake.lastSummary"
    private static let lastWakeRanKey = "nativeAgent.wake.lastRan"
    private static let lastWakeOkKey = "nativeAgent.wake.lastOk"

    private let fileManager: FileManager
    private let lock = NSLock()

    public init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    /// `<Application Support>/native-agent-wakes` — the same base the built-in
    /// memory provider uses, so the agent's durable state lives in one place.
    public var directoryURL: URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent(Self.directoryName, isDirectory: true)
    }

    private var fileURL: URL { directoryURL.appendingPathComponent(Self.fileName, isDirectory: false) }

    // ── Engine config discovery (works with no WebView alive) ────────────────

    /// Absolute path of the engine config `initialize()` persisted, or nil when
    /// the app never initialised the agent or the file is gone.
    public var engineConfigPath: String? {
        guard let path = UserDefaults.standard.string(forKey: Self.configPathKey),
              !path.isEmpty,
              fileManager.fileExists(atPath: path) else {
            return nil
        }
        return path
    }

    // ── Surfaced messages ───────────────────────────────────────────────────

    /// Appends one record; returns it as a JSON-encodable dictionary.
    @discardableResult
    public func append(
        source: String,
        title: String? = nil,
        body: String? = nil,
        text: String? = nil,
        jobId: String? = nil,
        runId: Int64? = nil,
        status: String? = nil,
        delivered: Bool? = nil,
        at: Date = Date()
    ) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }

        var record: [String: Any] = [
            "id": UUID().uuidString,
            "at": ISO8601DateFormatter().string(from: at),
            "source": source,
            "read": false,
        ]
        if let title, !title.isEmpty { record["title"] = title }
        if let body, !body.isEmpty { record["body"] = body }
        if let text, !text.isEmpty { record["text"] = text }
        if let jobId, !jobId.isEmpty {
            record["jobId"] = jobId
            // `taskId` is the field name the previous generation's contract used
            // for the same value; keeping it means old readers keep working.
            record["taskId"] = jobId
        }
        if let runId { record["runId"] = runId }
        if let status, !status.isEmpty { record["status"] = status }
        if let delivered { record["delivered"] = delivered }

        var all = readAll()
        all.append(record)
        if all.count > Self.maxRecords { all.removeFirst(all.count - Self.maxRecords) }
        writeAll(all)
        return record
    }

    /// Newest-first page plus the unread count; optionally marks the page read.
    public func load(limit: Int, markRead: Bool) -> (messagesJson: String, count: Int, unread: Int) {
        lock.lock()
        defer { lock.unlock() }

        let all = readAll()
        let page = Array(all.suffix(max(limit, 1)).reversed())
        if markRead && !page.isEmpty {
            let ids = Set(page.compactMap { $0["id"] as? String })
            writeAll(all.map { record in
                guard let id = record["id"] as? String, ids.contains(id) else { return record }
                var updated = record
                updated["read"] = true
                return updated
            })
        }
        let unread = readAll().filter { ($0["read"] as? Bool) != true }.count
        let data = (try? JSONSerialization.data(withJSONObject: page, options: [])) ?? Data("[]".utf8)
        return (String(data: data, encoding: .utf8) ?? "[]", page.count, unread)
    }

    /// Empties the queue; returns how many records were dropped.
    public func clear() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let count = readAll().count
        writeAll([])
        return count
    }

    public func unreadCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return readAll().filter { ($0["read"] as? Bool) != true }.count
    }

    private func readAll() -> [[String: Any]] {
        guard let data = try? Data(contentsOf: fileURL),
              let array = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
            // A truncated file must never break a wake: start clean.
            return []
        }
        return array
    }

    private func writeAll(_ records: [[String: Any]]) {
        try? fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        guard let data = try? JSONSerialization.data(withJSONObject: records, options: []) else { return }
        do {
            // Atomic write: a crash mid-write cannot leave half a queue behind.
            try data.write(to: fileURL, options: .atomic)
        } catch {
            try? data.write(to: fileURL)
        }
    }

    // ── Wake telemetry (what getWakeStatus reports) ──────────────────────────

    public var intervalMinutes: Int {
        get {
            let stored = UserDefaults.standard.integer(forKey: Self.intervalKey)
            return stored > 0 ? stored : Self.defaultIntervalMinutes
        }
        set { UserDefaults.standard.set(newValue, forKey: Self.intervalKey) }
    }

    public var requiresCharging: Bool {
        get { UserDefaults.standard.bool(forKey: Self.chargingKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.chargingKey) }
    }

    /// `ok` answers one question: *did the wake run* (engine restored,
    /// `handle_wake` returned). It is not "did every cron job succeed" — a job that
    /// failed is in `summary` and in the surfaced records, so a wake that ran and
    /// reported a failure stays `ok = true` and the failure is still visible.
    public func recordWake(source: String, summary: String, ran: Int, ok: Bool) {
        let defaults = UserDefaults.standard
        defaults.set(ISO8601DateFormatter().string(from: Date()), forKey: Self.lastWakeAtKey)
        defaults.set(source, forKey: Self.lastWakeSourceKey)
        defaults.set(summary, forKey: Self.lastWakeSummaryKey)
        defaults.set(ran, forKey: Self.lastWakeRanKey)
        defaults.set(ok, forKey: Self.lastWakeOkKey)
    }

    public var lastWakeAt: String? { UserDefaults.standard.string(forKey: Self.lastWakeAtKey) }
    public var lastWakeSource: String? { UserDefaults.standard.string(forKey: Self.lastWakeSourceKey) }
    public var lastWakeSummary: String? { UserDefaults.standard.string(forKey: Self.lastWakeSummaryKey) }
    public var lastWakeRan: Int { UserDefaults.standard.integer(forKey: Self.lastWakeRanKey) }
    public var lastWakeOk: Bool { UserDefaults.standard.bool(forKey: Self.lastWakeOkKey) }
}
