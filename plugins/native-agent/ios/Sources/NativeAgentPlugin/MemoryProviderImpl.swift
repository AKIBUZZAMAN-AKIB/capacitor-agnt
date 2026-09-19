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
///    (`native-agent-memory/memory.json`), written atomically (temp file +
///    rename) and capped ([maxEntries]) so it cannot grow forever. It never
///    leaves the device.
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

    private let lock = NSLock()
    private let storeURL: URL

    init(fileManager: FileManager = .default) {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let directory = base.appendingPathComponent(Self.directoryName, isDirectory: true)
        storeURL = directory.appendingPathComponent(Self.fileName, isDirectory: false)
    }

    // ── MemoryProvider ──────────────────────────────────────────────────────

    public func store(key: String, text: String, metadataJson: String?) -> String {
        respond {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return errorJson("Nothing to store: 'text' is empty.")
            }
            if trimmed.count > Self.maxTextLength {
                return errorJson("Memory entry too large (\(trimmed.count) chars, limit \(Self.maxTextLength)).")
            }

            let resolvedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "mem-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8))"
                : key.trimmingCharacters(in: .whitespacesAndNewlines)

            lock.lock()
            defer { lock.unlock() }

            var entries = readEntries()
            let now = Date().timeIntervalSince1970 * 1000
            var record: [String: Any] = [
                "key": resolvedKey,
                "text": trimmed,
                "updatedAt": now,
            ]
            if let metadata = parseMetadata(metadataJson) {
                record["metadata"] = metadata
            }

            if let index = entries.firstIndex(where: { ($0["key"] as? String) == resolvedKey }) {
                record["createdAt"] = entries[index]["createdAt"] ?? now
                entries[index] = record
            } else {
                record["createdAt"] = now
                entries.append(record)
            }
            if entries.count > Self.maxEntries {
                entries.removeFirst(entries.count - Self.maxEntries) // oldest first
            }
            writeEntries(entries)

            return jsonString(["success": true, "key": resolvedKey])
        }
    }

    public func recall(query: String, limit: UInt32) -> String {
        search(query: query, maxResults: limit)
    }

    public func search(query: String, maxResults: UInt32) -> String {
        respond {
            let limit = max(1, min(Int(maxResults), Self.maxResults))

            lock.lock()
            let entries = readEntries()
            lock.unlock()

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

            let entries = readEntries()
            let kept = entries.filter { ($0["key"] as? String) != wanted }
            if kept.count == entries.count {
                return errorJson("No memory stored under key '\(wanted)'.")
            }
            writeEntries(kept)
            return jsonString(["success": true, "key": wanted])
        }
    }

    public func list(prefix: String?, limit: UInt32?) -> String {
        respond {
            let wanted = (prefix ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let cap = max(1, min(Int(limit ?? UInt32(Self.maxResults)), Self.maxResults))

            lock.lock()
            let entries = readEntries()
            lock.unlock()

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

    private func score(entries: [[String: Any]], query: String) -> [Hit] {
        let queryTokens = tokenize(query)
        let phrase = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if queryTokens.isEmpty && phrase.count < Self.minPhraseLength { return [] }
        if entries.isEmpty { return [] }

        // document frequency: a shared rare word should count for more than a
        // shared common one — this is what makes the scorer usable without
        // embeddings
        var documentFrequency: [String: Int] = [:]
        var tokenCache: [Int: [String]] = [:]
        for (index, record) in entries.enumerated() {
            let tokens = tokenize("\(record["text"] as? String ?? "") \(record["key"] as? String ?? "")")
            tokenCache[index] = tokens
            for token in Set(tokens) {
                documentFrequency[token, default: 0] += 1
            }
        }

        let total = Double(entries.count)
        var hits: [Hit] = []

        for (index, record) in entries.enumerated() {
            let tokens = tokenCache[index] ?? []
            if tokens.isEmpty { continue }

            var score = 0.0
            for token in queryTokens {
                let occurrences = tokens.filter { $0 == token }.count
                if occurrences == 0 { continue }
                let frequency = Double(documentFrequency[token] ?? 1)
                let inverseFrequency = log(1.0 + total / frequency)
                // saturating term frequency: 3 hits are not 3x as relevant as 1
                let termFrequency = Double(occurrences) / (Double(occurrences) + 0.5)
                score += inverseFrequency * (1.0 + termFrequency)
            }

            let text = (record["text"] as? String ?? "").lowercased()
            let key = (record["key"] as? String ?? "").lowercased()
            if phrase.count >= Self.minPhraseLength && text.contains(phrase) {
                score += Self.phraseBonus
            }
            for token in queryTokens where key.contains(token) {
                score += Self.keyBonus
            }
            for token in queryTokens where token.count >= Self.minPartialLength && tokens.contains(where: { $0.contains(token) }) {
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

    /// Lowercase word/number runs of at least two characters.
    private func tokenize(_ text: String) -> [String] {
        var tokens: [String] = []
        var current = String.UnicodeScalarView()
        func flush() {
            if current.count >= Self.minTokenLength {
                tokens.append(String(current))
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
        return tokens
    }

    // ── storage ─────────────────────────────────────────────────────────────

    private func readEntries() -> [[String: Any]] {
        guard let data = try? Data(contentsOf: storeURL),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let entries = root["entries"] as? [[String: Any]] else {
            if FileManager.default.fileExists(atPath: storeURL.path) {
                // A corrupt file must not break every future tool call: park it
                // for inspection and start clean.
                let corrupt = storeURL.appendingPathExtension("corrupt-\(Int(Date().timeIntervalSince1970 * 1000))")
                try? FileManager.default.moveItem(at: storeURL, to: corrupt)
            }
            return []
        }
        return entries
    }

    private func writeEntries(_ entries: [[String: Any]]) {
        let directory = storeURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let root: [String: Any] = ["version": Self.formatVersion, "entries": entries]
        guard let data = try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]) else { return }
        do {
            // `.atomic` writes to a temp file and renames it over the target, so a
            // crash mid-write cannot leave a half-written memory store behind.
            try data.write(to: storeURL, options: .atomic)
        } catch {
            try? data.write(to: storeURL)
        }
    }

    private func parseMetadata(_ metadataJson: String?) -> [String: Any]? {
        guard let raw = metadataJson?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let data = raw.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return nil
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
        let escaped = message
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "{\"error\":\"\(escaped)\"}"
    }

    /// Single exit point for every method. Swift has no catchable exceptions here
    /// (every risk is already a `try?`), so this exists to make the boundary rule
    /// explicit: the FFI always receives a JSON string, and failures are reported
    /// as data by the helpers above instead of thrown at Rust.
    private func respond(_ block: () -> String) -> String {
        block()
    }

    private static let directoryName = "native-agent-memory"
    private static let fileName = "memory.json"
    private static let formatVersion = 1
    private static let maxEntries = 2_000
    private static let maxTextLength = 20_000
    private static let maxResults = 200
    private static let minTokenLength = 2
    private static let minPhraseLength = 3
    private static let minPartialLength = 4
    private static let phraseBonus = 2.0
    private static let keyBonus = 0.75
    private static let partialBonus = 0.25
}
