import Capacitor
import Foundation

#if canImport(phone_buddy_ffi)
import phone_buddy_ffi
#endif

/// Capacitor wrapper for the PhoneBuddy engine on iOS — parity with the Android
/// plugin so `NativeKit.phonebuddy.*` behaves the same on both platforms.
///
/// Scope (identical to Android): background wakes (BGProcessingTask) and
/// surfaced messages, plus the engine control needed to produce them.
///
/// The Rust static library comes from the public SDK source and is built by
/// `.github/workflows/phonebuddy-ios.yml` into
/// `ios/Frameworks/PhoneBuddyFFI.xcframework`, exposed to Swift as the module
/// `phone_buddy_ffi`. Until that binary exists the second half of this file
/// compiles instead: every method answers honestly (`available: false`,
/// `unavailable()`) rather than pretending, so a checkout without the framework
/// still builds — and the JS bridge falls back to its documented envelope.
@objc(PhoneBuddyAgentPlugin)
public class PhoneBuddyAgentPlugin: CAPPlugin {

    private static let engineGeneration = "phonebuddy-0.2.0"
    private static let eventName = "phoneBuddyEvent"
    private static let defaultSession = "main"

    /// Only touched by the engine-backed half of this file; harmless (and unused)
    /// when the Rust framework is missing.
    private var enginePointer: UnsafeMutableRawPointer?
    private let engineQueue = DispatchQueue(label: "com.t6x.plugins.phonebuddy.engine")
    private var callbackBoxes: [CallbackBox] = []

    public override func load() {
        // Registering in load() means a wake that launches the app cold still has
        // a handler installed before iOS delivers the BGTask.
        PhoneBuddyBackgroundTask.registerIfNeeded()
        PhoneBuddyBackgroundTask.onWake = { [weak self] in
            self?.runWake(source: "bgtask").summary ?? "plugin not loaded"
        }
    }

    // ── Filesystem / persistence helpers (no FFI) ────────────────────────────

    private func sandboxRoot() -> URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let root = base.appendingPathComponent("phonebuddy", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func schedulerFile(root: URL) -> URL { root.appendingPathComponent("scheduler.json") }

    private func pendingTasks(root: URL) -> [[String: Any]] {
        guard let data = try? Data(contentsOf: schedulerFile(root: root)),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return array.filter { ($0["status"] as? String ?? "scheduled") == "scheduled" }
    }

    private func markTaskCompleted(root: URL, taskId: String) {
        guard let data = try? Data(contentsOf: schedulerFile(root: root)),
              var array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return
        }
        for index in array.indices where (array[index]["id"] as? String) == taskId {
            array[index]["status"] = "completed"
        }
        if let updated = try? JSONSerialization.data(withJSONObject: array, options: []) {
            try? updated.write(to: schedulerFile(root: root), options: .atomic)
        }
    }

    private static func currentArchitecture() -> String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    // ── iOS methods that do not need the Rust library ────────────────────────

    @objc func scheduleBackgroundWakes(_ call: CAPPluginCall) {
        let requested = max(call.getInt("intervalMinutes") ?? 30, 15)
        let outcome = PhoneBuddyBackgroundTask.schedule(intervalMinutes: requested)
        PhoneBuddyWakeStore.intervalMinutes = requested
        var result: [String: Any] = [
            "jobScheduled": outcome.ok,
            "intervalMinutes": requested,
            "engineGeneration": Self.engineGeneration,
        ]
        if let reason = outcome.reason { result["reason"] = reason }
        call.resolve(result)
    }

    @objc func cancelBackgroundWakes(_ call: CAPPluginCall) {
        let cancelled = PhoneBuddyBackgroundTask.cancel()
        call.resolve([
            "jobScheduled": false,
            "jobCancelled": cancelled,
            "intervalMinutes": 0,
            "engineGeneration": Self.engineGeneration,
        ])
    }

    @objc func getWakeStatus(_ call: CAPPluginCall) {
        let root = sandboxRoot()
        call.resolve([
            "jobScheduled": PhoneBuddyWakeStore.intervalMinutes > 0,
            "intervalMinutes": PhoneBuddyWakeStore.intervalMinutes,
            "lastWakeAt": PhoneBuddyWakeStore.lastWakeAt ?? "",
            "lastWakeSource": PhoneBuddyWakeStore.lastWakeSource ?? "",
            "lastWakeSummary": PhoneBuddyWakeStore.lastWakeSummary ?? "",
            "pendingTasks": pendingTasks(root: root).count,
            "engineGeneration": Self.engineGeneration,
        ])
    }

    @objc func loadSurfacedMessages(_ call: CAPPluginCall) {
        let page = PhoneBuddySurfacedStore(rootDir: sandboxRoot())
            .load(limit: call.getInt("limit") ?? 50, markRead: call.getBool("markRead") ?? false)
        call.resolve([
            "messagesJson": page.messagesJson,
            "count": page.count,
            "unread": page.unread,
            "engineGeneration": Self.engineGeneration,
        ])
    }

    @objc func clearSurfacedMessages(_ call: CAPPluginCall) {
        let cleared = PhoneBuddySurfacedStore(rootDir: sandboxRoot()).clear()
        call.resolve(["cleared": cleared, "engineGeneration": Self.engineGeneration])
    }

    @objc func handleWake(_ call: CAPPluginCall) {
        let source = call.getString("source") ?? "manual"
        let outcome = runWake(source: source)
        call.resolve([
            "ran": outcome.ran,
            "summary": outcome.summary,
            "engineGeneration": Self.engineGeneration,
        ])
    }
}

// MARK: - Engine-backed implementation (only when the Rust library is present)

#if canImport(phone_buddy_ffi)

extension PhoneBuddyAgentPlugin {

    @objc func checkAvailability(_ call: CAPPluginCall) {
        call.resolve([
            "abi": Self.currentArchitecture(),
            "is64Bit": MemoryLayout<Int>.size == 8,
            "available": true,
            "version": String(cString: pb_version()),
            "engineGeneration": Self.engineGeneration,
        ])
    }

    @objc func initialize(_ call: CAPPluginCall) {
        let configJson = buildEngineConfig(call)
        var errorPointer: UnsafeMutablePointer<CChar>?
        let handle = configJson.withCString { pb_engine_new($0, &errorPointer) }
        guard let handle else {
            let message = errorPointer.map { String(cString: $0) } ?? "unknown error"
            if let errorPointer { pb_string_free(errorPointer) }
            call.reject("pb_engine_new failed: \(message)")
            return
        }
        freeEnginePointer()
        enginePointer = handle
        PhoneBuddyWakeStore.engineConfigJson = configJson
        call.resolve([
            "initialized": true,
            "rootDir": sandboxRoot().path,
            "model": call.getString("model") ?? "",
            "engineGeneration": Self.engineGeneration,
            "defaultsApplied": [] as [String],
        ])
    }

    @objc func shutdown(_ call: CAPPluginCall) {
        freeEnginePointer()
        call.resolve()
    }

    @objc func sendMessage(_ call: CAPPluginCall) {
        guard let handle = enginePointer else {
            call.reject("engine is not initialized — call initialize() first")
            return
        }
        let sessionId = call.getString("sessionId") ?? Self.defaultSession
        let text = call.getString("text")
        let turnJson = call.getString("turnJson")
        guard text != nil || turnJson != nil else {
            call.reject("sendMessage requires either 'text' or 'turnJson'")
            return
        }
        engineQueue.async { [weak self] in
            var errorPointer: UnsafeMutablePointer<CChar>?
            let context = self?.eventCallback(sessionId: sessionId)
            let resultPointer: UnsafeMutablePointer<CChar>?
            if let turnJson {
                resultPointer = turnJson.withCString {
                    pb_engine_chat_v2(handle, sessionId, $0, eventCallbackShim, context, &errorPointer)
                }
            } else {
                resultPointer = text!.withCString {
                    pb_engine_chat(handle, sessionId, $0, eventCallbackShim, context, &errorPointer)
                }
            }
            guard let resultPointer else {
                let message = errorPointer.map { String(cString: $0) } ?? "engine returned no result"
                if let errorPointer { pb_string_free(errorPointer) }
                call.reject("chat failed: \(message)")
                return
            }
            let resultJson = String(cString: resultPointer)
            pb_string_free(resultPointer)
            let parsed = (try? JSONSerialization.jsonObject(with: Data(resultJson.utf8))) as? [String: Any] ?? [:]
            call.resolve([
                "sessionId": sessionId,
                "finalText": parsed["final_text"] as? String ?? "",
                "turnsUsed": parsed["turns_used"] as? Int ?? 0,
                "resultJson": resultJson,
            ])
        }
    }

    @objc func abort(_ call: CAPPluginCall) {
        if let enginePointer {
            pb_engine_cancel(enginePointer, call.getString("sessionId") ?? Self.defaultSession)
        }
        call.resolve()
    }

    @objc func listSessions(_ call: CAPPluginCall) {
        guard let handle = enginePointer else { call.reject("engine is not initialized"); return }
        var errorPointer: UnsafeMutablePointer<CChar>?
        guard let pointer = pb_engine_list_sessions(handle, &errorPointer) else {
            let message = errorPointer.map { String(cString: $0) } ?? "unknown error"
            if let errorPointer { pb_string_free(errorPointer) }
            call.reject("listSessions failed: \(message)")
            return
        }
        let json = String(cString: pointer)
        pb_string_free(pointer)
        call.resolve(["sessionsJson": json])
    }

    @objc func getSession(_ call: CAPPluginCall) {
        guard let handle = enginePointer else { call.reject("engine is not initialized"); return }
        guard let sessionId = call.getString("sessionId") else {
            call.reject("sessionId is required")
            return
        }
        var errorPointer: UnsafeMutablePointer<CChar>?
        guard let pointer = pb_engine_get_session(handle, sessionId, &errorPointer) else {
            let message = errorPointer.map { String(cString: $0) }
            if let errorPointer { pb_string_free(errorPointer) }
            if let message {
                call.reject("getSession failed for '\(sessionId)': \(message)")
            } else {
                call.resolve(["sessionJson": "null"])
            }
            return
        }
        let json = String(cString: pointer)
        pb_string_free(pointer)
        call.resolve(["sessionJson": json])
    }

    @objc func deleteSession(_ call: CAPPluginCall) {
        guard let handle = enginePointer, let sessionId = call.getString("sessionId") else {
            call.reject("engine is not initialized or sessionId is missing")
            return
        }
        call.resolve(["deleted": pb_engine_delete_session(handle, sessionId) == 0])
    }

    @objc func setHostTools(_ call: CAPPluginCall) {
        guard let handle = enginePointer else { call.reject("engine is not initialized"); return }
        guard let toolsJson = call.getString("toolsJson") else {
            call.reject("toolsJson is required")
            return
        }
        var errorPointer: UnsafeMutablePointer<CChar>?
        let code = toolsJson.withCString { pb_engine_set_host_tools(handle, $0, &errorPointer) }
        if code != 0 {
            let message = errorPointer.map { String(cString: $0) } ?? "unknown error"
            if let errorPointer { pb_string_free(errorPointer) }
            call.reject("engine rejected the host tools: \(message)")
            return
        }
        call.resolve(["ok": true, "engineGeneration": Self.engineGeneration])
    }

    @objc func hostToolResult(_ call: CAPPluginCall) {
        guard let handle = enginePointer, let callId = call.getString("callId") else {
            call.reject("engine is not initialized or callId is missing")
            return
        }
        let ok = call.getBool("ok") ?? true
        let output = call.getString("output") ?? ""
        var errorPointer: UnsafeMutablePointer<CChar>?
        let code = output.withCString {
            pb_engine_host_tool_result(handle, callId, ok ? 1 : 0, $0, &errorPointer)
        }
        var result: [String: Any] = ["ok": code == 0, "engineGeneration": Self.engineGeneration]
        if code != 0 {
            result["reason"] = errorPointer.map { String(cString: $0) } ?? "engine rejected the result"
            if let errorPointer { pb_string_free(errorPointer) }
        }
        call.resolve(result)
    }

    // ── internals ───────────────────────────────────────────────────────────

    /// Runs one wake: due tasks in `scheduler.json` → engine runs → surfaced
    /// messages. Mirrors `PhoneBuddyWakeRunner.run()` on Android.
    @discardableResult
    func runWake(source: String) -> (ran: Int, summary: String) {
        let root = sandboxRoot()
        let surfaced = PhoneBuddySurfacedStore(rootDir: root)
        guard let config = PhoneBuddyWakeStore.engineConfigJson else {
            let summary = "engine was never initialised — call initialize() so its config can be restored in the background"
            PhoneBuddyWakeStore.recordWake(source: source, summary: summary)
            return (0, summary)
        }
        let tasks = pendingTasks(root: root)
        guard !tasks.isEmpty else {
            let summary = "no scheduled tasks were due"
            PhoneBuddyWakeStore.recordWake(source: source, summary: summary)
            return (0, summary)
        }
        var errorPointer: UnsafeMutablePointer<CChar>?
        guard let handle = config.withCString({ pb_engine_new($0, &errorPointer) }) else {
            let message = errorPointer.map { String(cString: $0) } ?? "unknown error"
            if let errorPointer { pb_string_free(errorPointer) }
            PhoneBuddyWakeStore.recordWake(source: source, summary: "engine rebuild failed: \(message)")
            return (0, "engine rebuild failed: \(message)")
        }
        defer { pb_engine_free(handle) }

        var ran = 0
        for task in tasks {
            let prompt = (task["prompt"] as? String) ?? "Run the scheduled task"
            let taskId = (task["id"] as? String) ?? "unknown"
            let sessionId = "sched-\(taskId)"
            var chatError: UnsafeMutablePointer<CChar>?
            let resultPointer = prompt.withCString { pb_engine_chat(handle, sessionId, $0, nil, nil, &chatError) }
            guard let resultPointer else {
                if let chatError { pb_string_free(chatError) }
                continue
            }
            let resultJson = String(cString: resultPointer)
            pb_string_free(resultPointer)
            let parsed = (try? JSONSerialization.jsonObject(with: Data(resultJson.utf8))) as? [String: Any] ?? [:]
            surfaced.append(
                source: source,
                title: (task["title"] as? String) ?? "Scheduled task",
                text: parsed["final_text"] as? String ?? resultJson,
                sessionId: sessionId,
                taskId: taskId
            )
            markTaskCompleted(root: root, taskId: taskId)
            ran += 1
        }
        let summary = "ran \(ran) of \(tasks.count) scheduled task(s)"
        PhoneBuddyWakeStore.recordWake(source: source, summary: summary)
        return (ran, summary)
    }

    /// Same "fill in what the host omitted" logic as the Kotlin `buildEngineConfig`.
    private func buildEngineConfig(_ call: CAPPluginCall) -> String {
        var config: [String: Any] = [:]
        if let raw = call.getString("configJson"),
           let parsed = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] {
            config = parsed
        }
        if config["root_dir"] == nil { config["root_dir"] = sandboxRoot().path }
        func fill(_ key: String, _ value: Any?) {
            guard config[key] == nil, let value else { return }
            config[key] = value
        }
        fill("api_key", call.getString("apiKey"))
        fill("base_url", call.getString("baseUrl"))
        fill("model", call.getString("model"))
        fill("locale", call.getString("locale"))
        fill("agent_name", call.getString("agentName"))
        fill("system_prompt_extra", call.getString("systemPromptExtra"))
        fill("max_turns", call.getInt("maxTurns"))
        fill("temperature", call.getDouble("temperature"))
        fill("max_output_tokens", call.getInt("maxOutputTokens"))
        if let extra = call.getObject("extra") {
            for (key, value) in extra where config[key] == nil { config[key] = value }
        }
        let data = (try? JSONSerialization.data(withJSONObject: config, options: [])) ?? Data("{}".utf8)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func freeEnginePointer() {
        if let enginePointer { pb_engine_free(enginePointer) }
        enginePointer = nil
    }

    private func eventCallback(sessionId: String) -> UnsafeMutableRawPointer {
        let box = CallbackBox { [weak self] payload in
            guard let self else { return }
            let eventType = ((try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any])?
                .keys.first ?? "Unknown"
            self.notifyListeners(Self.eventName, data: [
                "eventType": eventType,
                "payloadJson": payload,
                "sessionId": sessionId,
            ])
        }
        callbackBoxes.append(box)
        return Unmanaged.passUnretained(box).toOpaque()
    }
}

/// Holds the Swift closure the C trampoline calls back into.
final class CallbackBox {
    let handler: (String) -> Void
    init(handler: @escaping (String) -> Void) { self.handler = handler }
}

/// C trampoline for `PbEventCallback`.
private let eventCallbackShim: PbEventCallback = { eventJson, userData in
    guard let eventJson, let userData else { return }
    let box = Unmanaged<CallbackBox>.fromOpaque(userData).takeUnretainedValue()
    box.handler(String(cString: eventJson))
}

#else

// MARK: - No Rust library in this build: honest answers, never a fake success

extension PhoneBuddyAgentPlugin {
    private static let unavailableReason =
        "the PhoneBuddy iOS library is not part of this build (run the 'PhoneBuddy FFI — iOS' workflow to produce it)"

    @objc func checkAvailability(_ call: CAPPluginCall) {
        call.resolve([
            "abi": Self.currentArchitecture(),
            "is64Bit": MemoryLayout<Int>.size == 8,
            "available": false,
            "reason": Self.unavailableReason,
            "engineGeneration": Self.engineGeneration,
        ])
    }

    @objc func initialize(_ call: CAPPluginCall) { call.unavailable(Self.unavailableReason) }
    @objc func shutdown(_ call: CAPPluginCall) { call.resolve() }
    @objc func sendMessage(_ call: CAPPluginCall) { call.unavailable(Self.unavailableReason) }
    @objc func abort(_ call: CAPPluginCall) { call.resolve() }
    @objc func listSessions(_ call: CAPPluginCall) { call.resolve(["sessionsJson": "[]"]) }
    @objc func getSession(_ call: CAPPluginCall) { call.resolve(["sessionJson": "null"]) }
    @objc func deleteSession(_ call: CAPPluginCall) { call.resolve(["deleted": false]) }
    @objc func setHostTools(_ call: CAPPluginCall) {
        call.resolve(["ok": false, "engineGeneration": Self.engineGeneration, "reason": Self.unavailableReason])
    }

    @objc func hostToolResult(_ call: CAPPluginCall) {
        call.resolve(["ok": false, "engineGeneration": Self.engineGeneration, "reason": Self.unavailableReason])
    }

    @discardableResult
    func runWake(source: String) -> (ran: Int, summary: String) {
        PhoneBuddyWakeStore.recordWake(source: source, summary: Self.unavailableReason)
        return (0, Self.unavailableReason)
    }
}

#endif
