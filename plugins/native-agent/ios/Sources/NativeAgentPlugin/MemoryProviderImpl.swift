import Foundation

/// Long-term memory for the agent — built in, file-backed, no vector database.
///
/// ## Why this exists (and why it is not LanceDB any more)
///
/// The engine's `memory_store` / `memory_recall` / `memory_search` /
/// `memory_forget` / `memory_list` tools store nothing themselves: they call a
/// host-side `MemoryProvider` (the UniFFI callback interface declared in
/// `Generated/native_agent_ffi.swift`) and the host owns the storage.
///
/// This class used to be gated behind `#if canImport(CapacitorLanceDB)`,
/// alongside a `LanceDBBridge` that opened a LanceDB handle and filled it with
/// hash-generated embeddings. The app never integrated that plugin, so
/// `makeIfAvailable()` returned nil, the engine kept `memory_provider = None`,
/// and every memory tool answered `{"error":"Memory provider not configured"}`.
///
/// The replacement is always present and needs no second native runtime:
///
///  * **Storage** — one JSON document under Application Support
///    (`native-agent-memory/memory.json`), written atomically and capped by
///    entry count, per-entry bytes, metadata bytes and total bytes. The directory
///    is excluded from backups; exclusion failures are reported rather than
///    silently ignored, and the data never leaves the device.
///  * **Search** — a lexical scorer (token overlap weighted by inverse document
///    frequency, plus whole-phrase and key-match bonuses), *not* embeddings.
///    Honest trade: no model download, no network, no extra dependency, no
///    multi-hundred-megabyte vector index; and it degrades gracefully because
///    the tool result says "lexical" instead of promising semantics it lacks.
///
/// ## Contract
///
/// Every method returns a JSON **string** and never throws across the FFI
/// boundary (a thrown Swift error would surface as a Rust error and fail the
/// model's tool call for something as mundane as a full disk):
///   * `store`  → `{"success":true,"key":"…"}`
///   * `recall` / `search` → `[{"key":…,"text":…,"score":…,"metadata":…}, …]`
///   * `list`   → `["key", …]`
///   * `forget` → `{"success":true,"key":"…"}`
///   * failure  → `{"error":"…"}`
public final class MemoryProviderImpl: MemoryProvider {

    /// The plugin calls this on every `initialize()`; the provider is always
    /// available now, so the return type stays optional only for source
    /// compatibility with the previous gated implementation.
    public static func makeIfAvailable() -> MemoryProvider? {
        MemoryProviderImpl()
    }

    // Static so foreground and background provider instances in this process
    // serialize read/modify/write cycles against the same JSON file.
    private static let sharedLock = NSLock()
    private var lock: NSLock { Self.sharedLock }
    private let storeURL: URL

    init(fileManager: FileManager = .default) {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let directory = base.appendingPathComponent(Self.directoryName, isDirectory: true)
        storeURL = directory.appendingPathComponent(Self.fileName, isDirectory: false)

        // Apply the backup policy during provider creation, before another
        // scheduled backup can include an existing store. Reads and writes retry
        // and verify the same policy, so a transient init failure is surfaced.
        if fileManager.fileExists(atPath: storeURL.path) {
            do {
                try excludeFromBackup(directory)
            } catch {
                NSLog("NativeAgentMemory: could not exclude existing memory store from backup: %@", error.localizedDescription)
            }
        }
    }

    // ── MemoryProvider ──────────────────────────────────────────────────────

    public func store(key: String, text: String, metadataJson: String?) -> String {
        respond {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return errorJson("Nothing to store: 'text' is empty.")
            }
            if trimmed.utf8.count > Self.maxTextLength {
                return errorJson("Memory entry too large (\(trimmed.utf8.count) UTF-8 bytes, limit \(Self.maxTextLength)).")
            }
            let resolvedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "mem-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8))"
                : key.trimmingCharacters(in: .whitespacesAndNewlines)
            if resolvedKey.utf8.count > Self.maxKeyBytes {
                return errorJson("Memory key exceeds the \(Self.maxKeyBytes) byte limit.")
            }
            let metadata = try parseMetadata(metadataJson)

            lock.lock()
            defer { lock.unlock() }

            var entries = try readEntries()
            let now = Date().timeIntervalSince1970 * 1000
            var record: [String: Any] = [
                "key": resolvedKey,
                "text": trimmed,
                "updatedAt": now,
            ]
            if let metadata = metadata {
                record["metadata"] = metadata
            }

            if let index = entries.firstIndex(where: { ($0["key"] as? String) == resolvedKey }) {
                record["createdAt"] = entries[index]["createdAt"] ?? now
                entries.remove(at: index)
                entries.append(record) // updates move to the newest/retained position
            } else {
                record["createdAt"] = now
                entries.append(record)
            }
            if entries.count > Self.maxEntries {
                entries.removeFirst(entries.count - Self.maxEntries) // oldest first
            }
            try writeEntries(entries)

            return jsonString(["success": true, "key": resolvedKey])
        }
    }

    public func recall(query: String, limit: UInt32) -> String {
        search(query: query, maxResults: limit)
    }

    public func search(query: String, maxResults: UInt32) -> String {
        respond {
            let limit = max(1, min(Int(maxResults), Self.maxResults))

            let entries = try synchronized { try readEntries() }

            let hits = score(entries: entries, query: query).prefix(limit)
            return jsonString(hits.map { hit -> [String: Any] in
                var object: [String: Any] = [
                    "key": hit.record["key"] as? String ?? "",
                    "text": hit.record["text"] as? String ?? "",
                    "score": hit.score,
                ]
                if let metadata = hit.record["metadata"] {
                    object["metadata"] = metadata
                }
                return object
            })
        }
    }

    public func forget(key: String) -> String {
        respond {
            let wanted = key.trimmingCharacters(in: .whitespacesAndNewlines)
            if wanted.isEmpty {
                return errorJson("Provide a key to forget.")
            }

            lock.lock()
            defer { lock.unlock() }

            let entries = try readEntries()
            let kept = entries.filter { ($0["key"] as? String) != wanted }
            if kept.count == entries.count {
                return errorJson("No memory stored under key '\(wanted)'.")
            }
            try writeEntries(kept)
            return jsonString(["success": true, "key": wanted])
        }
    }

    public func list(prefix: String?, limit: UInt32?) -> String {
        respond {
            let wanted = (prefix ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cap = max(1, min(Int(limit ?? UInt32(Self.maxResults)), Self.maxResults))

            let entries = try synchronized { try readEntries() }

            let sorted = entries.sorted {
                ($0["updatedAt"] as? Double ?? 0) > ($1["updatedAt"] as? Double ?? 0)
            }
            var keys: [String] = []
            for record in sorted {
                guard let candidate = record["key"] as? String else { continue }
                if wanted.isEmpty || candidate.hasPrefix(wanted) {
                    keys.append(candidate)
                    if keys.count >= cap { break }
                }
            }
            return jsonString(keys)
        }
    }

    // ── scoring (lexical, deterministic, no embeddings) ──────────────────────

    private struct Hit {
        let record: [String: Any]
        let score: Double
    }

    private struct TokenStats {
        let frequencies: [String: Int]
        let partialMatches: Set<String>
    }

    private func score(entries: [[String: Any]], query: String) -> [Hit] {
        var seenQueryTokens = Set<String>()
        let queryTokens = tokenize(query, maxTokens: Self.maxQueryTokens)
            .filter { seenQueryTokens.insert($0).inserted }
        let phrase = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if queryTokens.isEmpty && phrase.count < Self.minPhraseLength { return [] }
        if entries.isEmpty { return [] }

        let querySet = Set(queryTokens)
        // Scan every token for exact matches so relevant words near the end of
        // a maximum-sized memory are not silently ignored. Retain only counts
        // for the bounded query (at most 32 terms). Partial-match bonuses stay
        // limited to the first 512 document tokens to keep mobile search cheap.
        let stats = entries.map { record in
            scanTokenStats(
                "\(record["text"] as? String ?? "") \(record["key"] as? String ?? "")",
                queryTokens: querySet
            )
        }
        var documentFrequency: [String: Int] = [:]
        for tokenStats in stats {
            for token in tokenStats.frequencies.keys {
                documentFrequency[token, default: 0] += 1
            }
        }

        let total = Double(entries.count)
        var hits: [Hit] = []
        for (index, record) in entries.enumerated() {
            let text = record["text"] as? String ?? ""
            let key = record["key"] as? String ?? ""
            let tokenStats = stats[index]
            var score = 0.0
            for token in queryTokens {
                let occurrences = tokenStats.frequencies[token] ?? 0
                if occurrences == 0 { continue }
                let frequency = Double(documentFrequency[token] ?? 1)
                let inverseFrequency = log(1.0 + total / frequency)
                let termFrequency = Double(occurrences) / (Double(occurrences) + 0.5)
                score += inverseFrequency * (1.0 + termFrequency)
            }

            if phrase.count >= Self.minPhraseLength && text.lowercased().contains(phrase) {
                score += Self.phraseBonus
            }
            let lowerKey = key.lowercased()
            for token in queryTokens where lowerKey.contains(token) {
                score += Self.keyBonus
            }
            for token in queryTokens where token.count >= Self.minPartialLength && tokenStats.partialMatches.contains(token) {
                score += Self.partialBonus
            }

            if score > 0 {
                hits.append(Hit(record: record, score: (score * 10_000).rounded() / 10_000))
            }
        }

        return hits.sorted {
            if $0.score != $1.score { return $0.score > $1.score }
            return ($0.record["updatedAt"] as? Double ?? 0) > ($1.record["updatedAt"] as? Double ?? 0)
        }
    }

    private func scanTokenStats(_ text: String, queryTokens: Set<String>) -> TokenStats {
        var frequencies: [String: Int] = [:]
        var partialMatches = Set<String>()
        var current = String.UnicodeScalarView()
        var documentTokenIndex = 0

        func flush() {
            if current.count >= Self.minTokenLength {
                let token = String(current)
                if queryTokens.contains(token) {
                    frequencies[token, default: 0] += 1
                }
                if documentTokenIndex < Self.maxPartialScanTokens {
                    for queryToken in queryTokens where queryToken.count >= Self.minPartialLength && token.contains(queryToken) {
                        partialMatches.insert(queryToken)
                    }
                }
                documentTokenIndex += 1
            }
            current = String.UnicodeScalarView()
        }

        for scalar in text.lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                current.append(scalar)
            } else {
                flush()
            }
        }
        flush()
        return TokenStats(frequencies: frequencies, partialMatches: partialMatches)
    }

    /// Lowercase word/number runs of at least two characters.
    private func tokenize(_ text: String, maxTokens: Int) -> [String] {
        var tokens: [String] = []
        var current = String.UnicodeScalarView()
        func flush() {
            if current.count >= Self.minTokenLength && tokens.count < maxTokens {
                tokens.append(String(current))
            }
            current = String.UnicodeScalarView()
        }
        for scalar in text.lowercased().unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) {
                current.append(scalar)
            } else {
                flush()
                if tokens.count >= maxTokens { break }
            }
        }
        if tokens.count < maxTokens { flush() }
        return tokens
    }

    // ── storage ─────────────────────────────────────────────────────────────

    private func synchronized<T>(_ block: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try block()
    }

    private func quarantineStore(_ reason: String) throws {
        let directory = storeURL.deletingLastPathComponent()
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        let backup = directory.appendingPathComponent(
            "\(storeURL.lastPathComponent).\(reason)-\(timestamp)-\(UUID().uuidString)"
        )
        // If preservation fails, propagate the error. The caller must not
        // continue with an empty store and atomically overwrite the only copy.
        try FileManager.default.moveItem(at: storeURL, to: backup)
    }

    private func readEntries() throws -> [[String: Any]] {
        let fileExists = FileManager.default.fileExists(atPath: storeURL.path)
        guard fileExists else { return [] }

        // Re-assert the policy when an existing store is opened too; otherwise
        // an older install whose previous `try?` failed could keep an included
        // Application Support directory forever.
        try excludeFromBackup(storeURL.deletingLastPathComponent())

        let attributes = try FileManager.default.attributesOfItem(atPath: storeURL.path)
        if let size = attributes[.size] as? NSNumber, size.int64Value > Int64(Self.maxStoreBytes) {
            // Older builds could leave a file far beyond today's cap. Do not
            // load it into memory before validating its on-disk size.
            try quarantineStore("oversized")
            return []
        }

        let data: Data
        do {
            data = try Data(contentsOf: storeURL)
        } catch {
            try quarantineStore("corrupt")
            return []
        }
        let parsed: Any
        do {
            parsed = try JSONSerialization.jsonObject(with: data)
        } catch {
            try quarantineStore("corrupt")
            return []
        }
        guard let root = parsed as? [String: Any] else {
            try quarantineStore("corrupt")
            return []
        }

        let version: Int
        if let rawVersion = root["version"] {
            guard let parsedVersion = rawVersion as? Int else {
                try quarantineStore("corrupt")
                return []
            }
            version = parsedVersion
        } else {
            // Accept early development stores that omitted the version field.
            version = Self.formatVersion
        }
        guard version == Self.formatVersion else {
            // Do not move or rewrite a valid document from another schema
            // version; a newer build may still be able to read it.
            throw NSError(domain: "NativeAgentMemory", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "memory store format \(version) is not supported by format \(Self.formatVersion)"
            ])
        }

        guard let rawEntries = root["entries"] as? [Any] else {
            try quarantineStore("corrupt")
            return []
        }
        var entries: [[String: Any]] = []
        entries.reserveCapacity(rawEntries.count)
        for item in rawEntries {
            guard let record = item as? [String: Any],
                  let key = record["key"] as? String,
                  !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  key.utf8.count <= Self.maxKeyBytes,
                  let text = record["text"] as? String,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf8.count <= Self.maxTextLength else {
                try quarantineStore("corrupt")
                return []
            }
            if let metadata = record["metadata"], !(metadata is NSNull), !(metadata is [String: Any]) {
                try quarantineStore("corrupt")
                return []
            }
            entries.append(record)
        }
        return entries
    }

    private func excludeFromBackup(_ directory: URL) throws {
        var directoryURL = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directoryURL.setResourceValues(values)

        let verified = try directoryURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
        guard verified.isExcludedFromBackup == true else {
            throw NSError(domain: "NativeAgentMemory", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "memory directory backup exclusion could not be verified"
            ])
        }
    }

    private func writeEntries(_ entries: [[String: Any]]) throws {
        let directory = storeURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try excludeFromBackup(directory)

        // Bound total persisted bytes as well as entry count, retaining the
        // newest records first. A single oversized record is an explicit error.
        var retainedNewestFirst: [[String: Any]] = []
        var bytesUsed = 128
        for record in entries.reversed() {
            if retainedNewestFirst.count >= Self.maxEntries { break }
            let recordData = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            if recordData.count + 128 > Self.maxStoreBytes {
                throw NSError(domain: "NativeAgentMemory", code: 1, userInfo: [NSLocalizedDescriptionKey: "one memory record exceeds the total store size limit"])
            }
            if bytesUsed + recordData.count + 2 > Self.maxStoreBytes { break }
            bytesUsed += recordData.count + 2
            retainedNewestFirst.append(record)
        }
        let boundedEntries = Array(retainedNewestFirst.reversed())
        let root: [String: Any] = ["version": Self.formatVersion, "entries": boundedEntries]
        let data = try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys])
        guard data.count <= Self.maxStoreBytes else {
            throw NSError(domain: "NativeAgentMemory", code: 2, userInfo: [NSLocalizedDescriptionKey: "memory store exceeds the total size limit"])
        }
        // Atomic write is mandatory. Never fall back to truncating the only copy.
        try data.write(to: storeURL, options: .atomic)
    }

    private func parseMetadata(_ metadataJson: String?) throws -> [String: Any]? {
        guard let raw = metadataJson?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        guard raw.utf8.count <= Self.maxMetadataBytes,
              let data = raw.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw NSError(domain: "NativeAgentMemory", code: 3, userInfo: [NSLocalizedDescriptionKey: "memory metadata must be a JSON object under the configured size limit"])
        }
        return object
    }

    private func jsonString(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let string = String(data: data, encoding: .utf8) else {
            return "{\"error\":\"Failed to encode JSON\"}"
        }
        return string
    }

    private func errorJson(_ message: String) -> String {
        // JSONSerialization escapes control characters as well as quotes and
        // backslashes; the hand-built string previously emitted invalid JSON
        // when an OS error contained a newline or tab.
        jsonString(["error": message])
    }

    /// Single exit point for every method. Swift has no catchable exceptions here
    /// (every risk is already a `try?`), so this exists to make the boundary rule
    /// explicit: the FFI always receives a JSON string, and failures are reported
    /// as data by the helpers above instead of thrown at Rust.
    private func respond(_ block: () throws -> String) -> String {
        do {
            return try block()
        } catch {
            return errorJson("memory store failed: \(error.localizedDescription)")
        }
    }

    private static let directoryName = "native-agent-memory"
    private static let fileName = "memory.json"
    private static let formatVersion = 1
    private static let maxEntries = 2_000
    private static let maxTextLength = 20_000
    private static let maxKeyBytes = 512
    private static let maxMetadataBytes = 16_384
    private static let maxStoreBytes = 64_000_000
    private static let maxResults = 200
    private static let maxQueryTokens = 32
    private static let maxPartialScanTokens = 512
    private static let minTokenLength = 2
    private static let minPhraseLength = 3
    private static let minPartialLength = 4
    private static let phraseBonus = 2.0
    private static let keyBonus = 0.75
    private static let partialBonus = 0.25
}
