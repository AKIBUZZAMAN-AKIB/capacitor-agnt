import CoreFoundation
import Foundation

/// Validated, atomic storage for app-owned agent runtime settings.
/// The sidecar lives next to `.native-agent-config.json`, outside the agent's
/// workspace sandbox, and is read by both foreground and background Rust runs.
enum AgentRuntimeConfigStore {
    private static let fileName = ".native-agent-runtime.json"
    private static let configPathKey = "mobilecron:native-agent-config-path"
    private static let maxConfigBytes = 32 * 1024
    private static let providers: Set<String> = [
        "anthropic", "openai", "gemini", "openrouter", "ovhcloud", "aihorde",
        "llm7", "opencode_zen", "kilo", "pollinations", "webllm",
    ]
    // `auto` is deliberately a free-only router: Kilo's live Free router runs
    // first, then OpenRouter's live Free Models Router.
    private static let defaultProviderOrder = ["kilo", "openrouter"]
    private static let stringMapFields: Set<String> = ["defaultModels", "providerBaseUrls"]
    private static let modelMapFields: Set<String> = [
        "providerModelProtocols", "providerToolCapabilities",
        "providerModelAuthRequirements", "providerModelStreamingCapabilities",
    ]
    private static let allowedFields: Set<String> = [
        "temperature", "maxTokens", "defaultMaxTurns", "contextCharBudget",
        "mcpToolTimeoutMs", "maxRetries", "baseRetryDelayMs", "maxRetryDelayMs",
        "defaultCronMaxTurns", "defaultHeartbeatMaxTurns", "defaultCronTimeoutMs",
        "defaultHeartbeatTimeoutMs", "defaultProvider", "defaultModels", "providerBaseUrls",
        "providerModelProtocols", "providerToolCapabilities",
        "providerModelAuthRequirements", "providerModelStreamingCapabilities", "autoRouting",
    ]

    private static var defaults: [String: Any] {
        [
            "temperature": 0.0,
            "maxTokens": 8_192,
            "defaultMaxTurns": 25,
            "contextCharBudget": 150_000,
            "mcpToolTimeoutMs": 30_000,
            "maxRetries": 2,
            "baseRetryDelayMs": 2_000,
            "maxRetryDelayMs": 30_000,
            "defaultCronMaxTurns": 10,
            "defaultHeartbeatMaxTurns": 5,
            "defaultCronTimeoutMs": 25_000,
            "defaultHeartbeatTimeoutMs": 25_000,
            "defaultProvider": "auto",
            "defaultModels": [
                "kilo": "kilo-auto/free",
                "openrouter": "openrouter/free",
            ],
            "providerBaseUrls": [String: String](),
            "providerModelProtocols": [String: [String: String]](),
            "providerToolCapabilities": [String: [String: Bool]](),
            "providerModelAuthRequirements": [String: [String: Bool]](),
            "providerModelStreamingCapabilities": [String: [String: Bool]](),
            "autoRouting": [
                "providerOrder": defaultProviderOrder,
                "failoverOnTransient": true,
                "maxFallbacks": 3,
            ] as [String: Any],
        ]
    }

    static func get() throws -> [String: Any] {
        let url = try runtimeFileURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return defaults }
        do {
            let data = try Data(contentsOf: url)
            let raw = try JSONSerialization.jsonObject(with: data)
            guard let object = raw as? [String: Any] else {
                throw configError("Runtime config root must be a JSON object")
            }
            return try validate(object)
        } catch {
            NSLog("NativeAgentConfig: invalid runtime config; using defaults: %@", error.localizedDescription)
            return defaults
        }
    }

    static func update(configJson: String) throws -> [String: Any] {
        guard configJson.utf8.count <= maxConfigBytes else {
            throw configError("Runtime config patch exceeds \(maxConfigBytes) bytes")
        }
        let data = Data(configJson.utf8)
        let raw = try JSONSerialization.jsonObject(with: data)
        guard let patch = raw as? [String: Any] else {
            throw configError("Runtime config patch must be a JSON object")
        }
        if let unknown = patch.keys.first(where: { !allowedFields.contains($0) }) {
            throw configError("Unknown runtime config field '\(unknown)'")
        }

        var merged = try get()
        for (key, value) in patch {
            if stringMapFields.contains(key) {
                try mergeStringMapPatch(&merged, field: key, raw: value)
            } else if modelMapFields.contains(key) {
                try mergeModelMapPatch(&merged, field: key, raw: value)
            } else if key == "autoRouting" {
                guard let additions = value as? [String: Any] else {
                    throw configError("autoRouting must be an object")
                }
                var current = merged[key] as? [String: Any] ?? [:]
                for (field, item) in additions {
                    guard !(item is NSNull) else { throw configError("autoRouting.\(field) cannot be null") }
                    current[field] = item
                }
                merged[key] = current
            } else {
                guard !(value is NSNull) else { throw configError("\(key) cannot be null") }
                merged[key] = value
            }
        }

        let normalized = try validate(merged)
        let output = try JSONSerialization.data(withJSONObject: normalized, options: [.sortedKeys])
        let url = try runtimeFileURL()
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try output.write(to: url, options: [.atomic])
        return normalized
    }

    private static func mergeStringMapPatch(_ target: inout [String: Any], field: String, raw: Any) throws {
        if raw is NSNull {
            target[field] = [String: String]()
            return
        }
        guard let additions = raw as? [String: Any] else {
            throw configError("\(field) must be an object or null")
        }
        var current = target[field] as? [String: String] ?? [:]
        for (provider, item) in additions {
            guard providers.contains(provider) else { throw configError("Unsupported \(field) key '\(provider)'") }
            if item is NSNull {
                current.removeValue(forKey: provider)
            } else if let text = item as? String {
                if field == "providerBaseUrls" {
                    guard provider != "webllm" else { throw configError("providerBaseUrls.webllm is not valid for a local browser runtime") }
                    current[provider] = try validateProviderURL(provider, text)
                } else {
                    let model = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !model.isEmpty, model.utf8.count <= 512 else {
                        throw configError("defaultModels.\(provider) must contain 1–512 bytes or null")
                    }
                    current[provider] = model
                }
            } else {
                throw configError("\(field).\(provider) must be a string or null")
            }
        }
        target[field] = current
    }

    private static func mergeModelMapPatch(_ target: inout [String: Any], field: String, raw: Any) throws {
        if raw is NSNull {
            target[field] = [String: [String: Any]]()
            return
        }
        guard let additions = raw as? [String: Any] else {
            throw configError("\(field) must be an object or null")
        }
        var current = target[field] as? [String: [String: Any]] ?? [:]
        for (provider, rawModels) in additions {
            guard providers.contains(provider) else { throw configError("Unsupported \(field) key '\(provider)'") }
            if rawModels is NSNull {
                current.removeValue(forKey: provider)
                continue
            }
            guard let modelPatch = rawModels as? [String: Any] else {
                throw configError("\(field).\(provider) must be an object or null")
            }
            var models = current[provider] ?? [:]
            for (model, value) in modelPatch {
                if value is NSNull { models.removeValue(forKey: model) }
                else { models[model] = value }
            }
            if models.isEmpty { current.removeValue(forKey: provider) }
            else { current[provider] = models }
        }
        target[field] = current
    }

    private static func validate(_ value: [String: Any]) throws -> [String: Any] {
        var result = defaults
        result["temperature"] = try number(value, "temperature", min: 0, max: 2)
        result["maxTokens"] = try integer(value, "maxTokens", min: 1, max: 200_000)
        result["defaultMaxTurns"] = try integer(value, "defaultMaxTurns", min: 1, max: 100)
        result["contextCharBudget"] = try integer(value, "contextCharBudget", min: 10_000, max: 1_000_000)
        result["mcpToolTimeoutMs"] = try integer(value, "mcpToolTimeoutMs", min: 1_000, max: 300_000)
        result["maxRetries"] = try integer(value, "maxRetries", min: 0, max: 5)
        result["baseRetryDelayMs"] = try integer(value, "baseRetryDelayMs", min: 0, max: 30_000)
        result["maxRetryDelayMs"] = try integer(value, "maxRetryDelayMs", min: 0, max: 120_000)
        result["defaultCronMaxTurns"] = try integer(value, "defaultCronMaxTurns", min: 1, max: 100)
        result["defaultHeartbeatMaxTurns"] = try integer(value, "defaultHeartbeatMaxTurns", min: 1, max: 100)
        result["defaultCronTimeoutMs"] = try integer(value, "defaultCronTimeoutMs", min: 1_000, max: 120_000)
        result["defaultHeartbeatTimeoutMs"] = try integer(value, "defaultHeartbeatTimeoutMs", min: 1_000, max: 120_000)

        let baseDelay = (result["baseRetryDelayMs"] as? NSNumber)?.int64Value ?? 0
        let maxDelay = (result["maxRetryDelayMs"] as? NSNumber)?.int64Value ?? 0
        guard maxDelay >= baseDelay else {
            throw configError("maxRetryDelayMs must be at least baseRetryDelayMs")
        }

        let defaultProviderValue = value["defaultProvider"] ?? defaults["defaultProvider"]!
        guard let defaultProvider = defaultProviderValue as? String,
              defaultProvider == "auto" || providers.contains(defaultProvider) else {
            throw configError("defaultProvider must be auto or one of the configured provider ids")
        }
        result["defaultProvider"] = defaultProvider
        result["defaultModels"] = try validateStringMap(value, field: "defaultModels")
        result["providerBaseUrls"] = try validateBaseUrlMap(value)
        result["providerModelProtocols"] = try validateModelMap(value, field: "providerModelProtocols")
        result["providerToolCapabilities"] = try validateModelMap(value, field: "providerToolCapabilities")
        result["providerModelAuthRequirements"] = try validateModelMap(value, field: "providerModelAuthRequirements")
        result["providerModelStreamingCapabilities"] = try validateModelMap(value, field: "providerModelStreamingCapabilities")
        result["autoRouting"] = try validateAutoRouting(value, defaultProvider: defaultProvider)
        return result
    }

    private static func objectField(_ value: [String: Any], _ field: String) throws -> [String: Any] {
        guard let candidate = value[field] else { return [:] }
        guard let object = candidate as? [String: Any] else { throw configError("\(field) must be an object") }
        return object
    }

    private static func validateStringMap(_ value: [String: Any], field: String) throws -> [String: String] {
        let raw = try objectField(value, field)
        guard raw.count <= providers.count else { throw configError("\(field) accepts at most \(providers.count) providers") }
        var result: [String: String] = [:]
        for (provider, rawModel) in raw {
            guard providers.contains(provider), let rawModel = rawModel as? String else {
                throw configError("\(field).\(provider) must be a configured provider model string")
            }
            let model = rawModel.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !model.isEmpty, model.utf8.count <= 512 else {
                throw configError("\(field).\(provider) must contain 1–512 bytes")
            }
            result[provider] = model
        }
        return result
    }

    private static func validateBaseUrlMap(_ value: [String: Any]) throws -> [String: String] {
        let raw = try objectField(value, "providerBaseUrls")
        guard raw.count <= providers.count else { throw configError("providerBaseUrls accepts at most \(providers.count) providers") }
        var result: [String: String] = [:]
        for (provider, rawURL) in raw {
            guard providers.contains(provider), provider != "webllm", let rawURL = rawURL as? String else {
                throw configError("providerBaseUrls.\(provider) must be a supported provider URL string")
            }
            result[provider] = try validateProviderURL(provider, rawURL)
        }
        return result
    }

    private static func validateModelMap(_ value: [String: Any], field: String) throws -> [String: [String: Any]] {
        let raw = try objectField(value, field)
        guard raw.count <= providers.count else { throw configError("\(field) accepts at most \(providers.count) providers") }
        var result: [String: [String: Any]] = [:]
        for (provider, rawModels) in raw {
            guard providers.contains(provider), let models = rawModels as? [String: Any] else {
                throw configError("\(field).\(provider) must be an object for a configured provider")
            }
            guard models.count <= 256 else { throw configError("\(field).\(provider) accepts at most 256 models") }
            var normalized: [String: Any] = [:]
            for (model, rawValue) in models {
                guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.utf8.count <= 512 else {
                    throw configError("\(field).\(provider) model id must contain 1–512 bytes")
                }
                if field == "providerModelProtocols" {
                    guard let protocolName = rawValue as? String, protocolSupported(provider: provider, protocolName: protocolName) else {
                        throw configError("\(field).\(provider).\(model) uses an incompatible protocol")
                    }
                    normalized[model] = protocolName
                } else {
                    guard let boolean = rawValue as? NSNumber, CFGetTypeID(boolean) == CFBooleanGetTypeID() else {
                        throw configError("\(field).\(provider).\(model) must be boolean")
                    }
                    if field == "providerToolCapabilities", provider == "aihorde", boolean.boolValue {
                        throw configError("providerToolCapabilities.aihorde.\(model) cannot be true because the published API schema has no tools field")
                    }
                    normalized[model] = boolean.boolValue
                }
            }
            result[provider] = normalized
        }
        return result
    }

    private static func protocolSupported(provider: String, protocolName: String) -> Bool {
        switch provider {
        case "anthropic": return protocolName == "anthropic_messages"
        case "openai": return ["openai_chat_completions", "openai_responses"].contains(protocolName)
        case "gemini": return protocolName == "gemini_generate_content"
        case "openrouter", "aihorde", "llm7", "kilo", "pollinations": return protocolName == "openai_chat_completions"
        case "ovhcloud": return ["openai_chat_completions", "openai_responses"].contains(protocolName)
        case "opencode_zen": return ["anthropic_messages", "openai_chat_completions", "openai_responses", "gemini_generate_content"].contains(protocolName)
        case "webllm": return protocolName == "webllm_chat_completions"
        default: return false
        }
    }

    private static func validateAutoRouting(_ value: [String: Any], defaultProvider: String) throws -> [String: Any] {
        let raw = try objectField(value, "autoRouting")
        let rawOrder = raw["providerOrder"] ?? defaultProviderOrder
        guard let order = rawOrder as? [String] else { throw configError("autoRouting.providerOrder must be an array of provider ids") }
        guard order.count <= providers.count else { throw configError("autoRouting.providerOrder has too many providers") }
        var seen = Set<String>()
        for provider in order {
            guard providers.contains(provider) else { throw configError("unsupported autoRouting provider '\(provider)'") }
            guard seen.insert(provider).inserted else { throw configError("autoRouting.providerOrder contains duplicate '\(provider)'") }
        }
        guard defaultProvider != "auto" || !order.isEmpty else {
            throw configError("autoRouting.providerOrder cannot be empty when defaultProvider is auto")
        }
        let failoverRaw = raw["failoverOnTransient"] ?? true
        guard let failover = failoverRaw as? NSNumber, CFGetTypeID(failover) == CFBooleanGetTypeID() else {
            throw configError("autoRouting.failoverOnTransient must be boolean")
        }
        let maxFallbackRaw = raw["maxFallbacks"] ?? 3
        let maxFallback = try integer(["maxFallbacks": maxFallbackRaw], "maxFallbacks", min: 0, max: 10)
        return ["providerOrder": order, "failoverOnTransient": failover.boolValue, "maxFallbacks": maxFallback]
    }

    private static func number(_ values: [String: Any], _ key: String, min: Double, max: Double) throws -> Double {
        let candidate = values[key] ?? defaults[key]!
        guard let raw = candidate as? NSNumber,
              CFGetTypeID(raw) != CFBooleanGetTypeID() else {
            throw configError("\(key) must be a number")
        }
        let value = raw.doubleValue
        guard value.isFinite, value >= min, value <= max else {
            throw configError("\(key) must be finite and between \(min) and \(max)")
        }
        return value
    }

    private static func integer(_ values: [String: Any], _ key: String, min: Int64, max: Int64) throws -> Int64 {
        let candidate = values[key] ?? defaults[key]!
        guard let raw = candidate as? NSNumber,
              CFGetTypeID(raw) != CFBooleanGetTypeID() else {
            throw configError("\(key) must be an integer")
        }
        let value = raw.doubleValue
        guard value.isFinite, value.rounded() == value, value >= Double(min), value <= Double(max) else {
            throw configError("\(key) must be an integer between \(min) and \(max)")
        }
        return raw.int64Value
    }

    private static func validateProviderURL(_ provider: String, _ raw: String) throws -> String {
        guard var parts = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil else {
            throw configError("providerBaseUrls.\(provider) must be a credential-free HTTP(S) URL with a host and no query or fragment")
        }
        while parts.path.hasSuffix("/") && !parts.path.isEmpty { parts.path.removeLast() }
        guard let normalized = parts.url?.absoluteString, normalized.utf8.count <= 2_048 else {
            throw configError("providerBaseUrls.\(provider) exceeds the 2048 byte limit or is invalid")
        }
        return normalized
    }

    private static func runtimeFileURL() throws -> URL {
        guard let path = UserDefaults.standard.string(forKey: configPathKey) else {
            throw configError("NativeAgent not initialized — call initialize() first")
        }
        let configURL = URL(fileURLWithPath: path)
        return configURL.deletingLastPathComponent().appendingPathComponent(fileName, isDirectory: false)
    }

    private static func configError(_ message: String) -> NSError {
        NSError(domain: "NativeAgentRuntimeConfig", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
