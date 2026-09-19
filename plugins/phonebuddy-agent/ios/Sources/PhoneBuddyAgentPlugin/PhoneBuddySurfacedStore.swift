import Foundation

/// Durable "surfaced messages" store — the iOS twin of
/// `PhoneBuddySurfaced.kt`. Same file name (`surfaced.json`), same record shape,
/// same cap, so the JS contract is identical on both platforms:
/// `{ messagesJson, count, unread }`.
public final class PhoneBuddySurfacedStore {

    public static let fileName = "surfaced.json"
    public static let maxRecords = 500

    private let rootDir: URL
    private let lock = NSLock()

    public init(rootDir: URL) {
        self.rootDir = rootDir
    }

    private var fileURL: URL { rootDir.appendingPathComponent(Self.fileName) }

    /// Appends one record; returns it as a JSON-encodable dictionary.
    @discardableResult
    public func append(
        source: String,
        title: String? = nil,
        body: String? = nil,
        text: String? = nil,
        sessionId: String? = nil,
        taskId: String? = nil,
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
        if let sessionId, !sessionId.isEmpty { record["sessionId"] = sessionId }
        if let taskId, !taskId.isEmpty { record["taskId"] = taskId }

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

    public func clear() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let count = readAll().count
        writeAll([])
        return count
    }

    private func readAll() -> [[String: Any]] {
        guard let data = try? Data(contentsOf: fileURL),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return array
    }

    private func writeAll(_ records: [[String: Any]]) {
        try? FileManager.default.createDirectory(at: rootDir, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: records, options: []) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }
}
