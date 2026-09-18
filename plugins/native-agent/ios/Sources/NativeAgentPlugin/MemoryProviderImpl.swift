import Foundation

#if canImport(CapacitorLanceDB) || canImport(CapacitorLancedb) || canImport(LanceDBPlugin)
public final class MemoryProviderImpl: MemoryProvider {
    public static func makeIfAvailable() -> MemoryProvider? {
        guard LanceDBBridge.shared.getOrCreateHandle() != nil else {
            return nil
        }
        return MemoryProviderImpl()
    }

    public func store(key: String, text: String, metadataJson: String?) -> String {
        guard let handle = LanceDBBridge.shared.getOrCreateHandle() else {
            return errorJson("Memory provider not configured")
        }

        let resolvedKey = key.isEmpty
            ? "mem-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(8))"
            : key
        let embedding = localHashEmbed(text, dim: Int(LanceDBBridge.embeddingDim))

        do {
            try LanceDBBridge.awaitResult {
                try await handle.store(
                    key: resolvedKey,
                    agentId: Self.defaultAgentId,
                    text: text,
                    embedding: embedding,
                    metadata: metadataJson
                )
            }
            return jsonString([
                "success": true,
                "key": resolvedKey,
            ])
        } catch {
            return errorJson(error.localizedDescription)
        }
    }

    public func recall(query: String, limit: UInt32) -> String {
        guard let handle = LanceDBBridge.shared.getOrCreateHandle() else {
            return errorJson("Memory provider not configured")
        }

        let embedding = localHashEmbed(query, dim: Int(LanceDBBridge.embeddingDim))

        do {
            let results = try LanceDBBridge.awaitResult {
                try await handle.search(
                    queryVector: embedding,
                    limit: limit,
                    filter: "agent_id = '\(Self.defaultAgentId)'"
                )
            }
            return jsonString(results.map { result in
                var object: [String: Any] = [
                    "key": result.key,
                    "text": result.text,
                    "score": result.score,
                ]
                if let metadata = result.metadata {
                    object["metadata"] = metadata
                }
                return object
            })
        } catch {
            return errorJson(error.localizedDescription)
        }
    }

    public func forget(key: String) -> String {
        guard let handle = LanceDBBridge.shared.getOrCreateHandle() else {
            return errorJson("Memory provider not configured")
        }
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return errorJson("Provide query or key.")
        }

        do {
            try LanceDBBridge.awaitResult {
                try await handle.delete(key: key)
            }
            return jsonString([
                "success": true,
                "key": key,
            ])
        } catch {
            return errorJson(error.localizedDescription)
        }
    }

    public func search(query: String, maxResults: UInt32) -> String {
        guard let handle = LanceDBBridge.shared.getOrCreateHandle() else {
            return errorJson("Memory provider not configured")
        }

        let embedding = localHashEmbed(query, dim: Int(LanceDBBridge.embeddingDim))

        do {
            let results = try LanceDBBridge.awaitResult {
                try await handle.search(
                    queryVector: embedding,
                    limit: maxResults,
                    filter: "agent_id = '\(Self.defaultAgentId)'"
                )
            }
            return jsonString(results.map { result in
                var object: [String: Any] = [
                    "key": result.key,
                    "text": result.text,
                    "score": result.score,
                ]
                if let metadata = result.metadata {
                    object["metadata"] = metadata
                }
                return object
            })
        } catch {
            return errorJson(error.localizedDescription)
        }
    }

    public func list(prefix: String?, limit: UInt32?) -> String {
        guard let handle = LanceDBBridge.shared.getOrCreateHandle() else {
            return errorJson("Memory provider not configured")
        }

        do {
            let keys = try LanceDBBridge.awaitResult {
                try await handle.list(prefix: prefix, limit: limit)
            }
            return jsonString(keys)
        } catch {
            return errorJson(error.localizedDescription)
        }
    }

    private static let defaultAgentId = "main"
    private static let whitespace = CharacterSet.whitespacesAndNewlines
    private static let posixLocale = Locale(identifier: "en_US_POSIX")
    private static let fnvOffset: UInt32 = 0x811c9dc5
    private static let fnvPrime: UInt32 = 0x01000193
    private static let goldenRatio: UInt32 = 2654435761
    private static let mixConstant: UInt32 = 0x45d9f3b
    private static let uintMaxDouble = Double(UInt32.max)

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

    private func fnv1a(_ text: String) -> UInt32 {
        var hash = Self.fnvOffset
        for scalar in text.unicodeScalars {
            hash ^= UInt32(scalar.value)
            hash = hash &* Self.fnvPrime
        }
        return hash
    }

    private func seededRandom(seed: UInt32, dim: Int) -> Float {
        var h = seed ^ (UInt32(dim) &* Self.goldenRatio)
        h = ((h >> 16) ^ h) &* Self.mixConstant
        h = ((h >> 16) ^ h) &* Self.mixConstant
        h = (h >> 16) ^ h
        return Float((Double(h) / Self.uintMaxDouble) * 2.0 - 1.0)
    }

    private func localHashEmbed(_ text: String, dim: Int) -> [Float] {
        let tokens = text
            .lowercased(with: Self.posixLocale)
            .components(separatedBy: Self.whitespace)
            .filter { !$0.isEmpty }
        var vector = Array(repeating: 0.0, count: dim)

        for token in tokens {
            let hash = fnv1a(token)
            for index in 0..<dim {
                vector[index] += Double(seededRandom(seed: hash, dim: index))
            }
        }

        let norm = sqrt(vector.reduce(0.0) { $0 + ($1 * $1) })
        let divisor = norm > 0 ? norm : 1
        return vector.map { Float($0 / divisor) }
    }
}
#else
public final class MemoryProviderImpl {
    public static func makeIfAvailable() -> MemoryProvider? {
        nil
    }
}
#endif
