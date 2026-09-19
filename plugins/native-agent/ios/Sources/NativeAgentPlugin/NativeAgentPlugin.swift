import Foundation
import Capacitor

@objc(NativeAgentPlugin)
public class NativeAgentPlugin: CAPPlugin, CAPBridgedPlugin {
    private static let configPathKey = "mobilecron:native-agent-config-path"
    public let identifier = "NativeAgentPlugin"
    public let jsName = "NativeAgent"
    public let pluginMethods: [CAPPluginMethod] = [
        // Diagnostics
        CAPPluginMethod(name: "checkAvailability", returnType: CAPPluginReturnPromise),
        // Lifecycle
        CAPPluginMethod(name: "initWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        // Agent
        CAPPluginMethod(name: "sendMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "followUp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "steer", returnType: CAPPluginReturnPromise),
        // Approval gate
        CAPPluginMethod(name: "respondToApproval", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respondToMcpTool", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respondToCronApproval", returnType: CAPPluginReturnPromise),
        // Auth
        CAPPluginMethod(name: "getAuthToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAuthKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteAuth", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refreshToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAuthStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exchangeOAuthCode", returnType: CAPPluginReturnPromise),
        // Sessions
        CAPPluginMethod(name: "listSessions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSession", returnType: CAPPluginReturnPromise),
        // Cron / heartbeat
        CAPPluginMethod(name: "addCronJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateCronJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeCronJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listCronJobs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runCronJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listCronRuns", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "handleWake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSchedulerConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSchedulerConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHeartbeatConfig", returnType: CAPPluginReturnPromise),
        // Skills
        CAPPluginMethod(name: "addSkill", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateSkill", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeSkill", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSkills", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSkill", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endSkill", returnType: CAPPluginReturnPromise),
        // Tool Permissions
        CAPPluginMethod(name: "seedToolPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setToolPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listToolPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetToolPermissions", returnType: CAPPluginReturnPromise),
        // MCP
        CAPPluginMethod(name: "startMcp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restartMcp", returnType: CAPPluginReturnPromise),
        // Models
        CAPPluginMethod(name: "getModels", returnType: CAPPluginReturnPromise),
        // Tools
        CAPPluginMethod(name: "invokeTool", returnType: CAPPluginReturnPromise),
    ]

    // ── Diagnostics ─────────────────────────────────────────────────────────

    /// Never rejects: reports whether the native agent library is usable here, so
    /// UI code can hide agent features instead of failing at call time. Mirrors
    /// the Android implementation (see docs/AGENT-ENGINE-0.5.2-BACKPORT.bn.md).
    @objc func checkAvailability(_ call: CAPPluginCall) {
        var available = true
        var reason = ""

        #if targetEnvironment(simulator)
        #if arch(arm64)
        let abi = "arm64-simulator"
        #else
        // The pinned xcframework ships ios-arm64 and ios-arm64-simulator slices
        // only — Intel Mac simulators have no matching slice.
        let abi = "x86_64-simulator"
        available = false
        reason = "NativeAgentFFI.xcframework has no x86_64-simulator slice in this build"
        #endif
        #else
        let abi = "arm64"
        #endif

        call.resolve([
            "abi": abi,
            "is64Bit": true,
            "available": available,
            "reason": reason,
            "engineGeneration": "0.5.2-public",
        ])
    }

    private var handle: NativeAgentHandle?

    // ── Helper ──────────────────────────────────────────────────────────────

    /// Resolves a `files://` prefixed path to an absolute iOS path
    /// under the app's Library directory to match the app workspace root.
    private func resolvePath(_ path: String) -> String {
        if path.hasPrefix("files://") {
            let relative = String(path.dropFirst("files://".count))
            let base = FileManager.default
                .urls(for: .libraryDirectory, in: .userDomainMask)
                .first!
                .path
            let resolved = (base as NSString).appendingPathComponent(relative)
            // Ensure parent directory exists
            let parentDir = (resolved as NSString).deletingLastPathComponent
            try? FileManager.default.createDirectory(
                atPath: parentDir,
                withIntermediateDirectories: true,
                attributes: nil
            )
            return resolved
        }
        return path
    }

    private func resolveConfigPath(workspacePath: String) -> String {
        URL(fileURLWithPath: workspacePath)
            .deletingLastPathComponent()
            .appendingPathComponent(".native-agent-config.json")
            .path
    }

    private func withHandle(_ call: CAPPluginCall, _ block: @escaping (NativeAgentHandle) -> Void) {
        guard let h = handle else {
            return call.reject("NativeAgent not initialized — call initialize() first")
        }
        // Use GCD instead of Task{} — Rust FFI calls use block_on() which blocks
        // the calling thread. Swift Task{} uses a cooperative thread pool that can
        // deadlock when threads are blocked. GCD's concurrent queue is safe for blocking.
        DispatchQueue.global(qos: .userInitiated).async {
            block(h)
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    @objc func initWorkspace(_ call: CAPPluginCall) {
        guard let dbPath = call.getString("dbPath") else {
            return call.reject("dbPath is required")
        }
        guard let workspacePath = call.getString("workspacePath") else {
            return call.reject("workspacePath is required")
        }
        guard let authProfilesPath = call.getString("authProfilesPath") else {
            return call.reject("authProfilesPath is required")
        }

        DispatchQueue.global(qos: .userInitiated).async { [self] in
            do {
                try callInitWorkspace(
                    config: InitConfig(
                        dbPath: self.resolvePath(dbPath),
                        workspacePath: self.resolvePath(workspacePath),
                        authProfilesPath: self.resolvePath(authProfilesPath)
                    )
                )
                call.resolve()
            } catch {
                call.reject("initWorkspace failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func initialize(_ call: CAPPluginCall) {
        guard let dbPath = call.getString("dbPath") else {
            return call.reject("dbPath is required")
        }
        guard let workspacePath = call.getString("workspacePath") else {
            return call.reject("workspacePath is required")
        }
        guard let authProfilesPath = call.getString("authProfilesPath") else {
            return call.reject("authProfilesPath is required")
        }

        DispatchQueue.global(qos: .userInitiated).async { [self] in
            do {
                let resolvedWorkspacePath = self.resolvePath(workspacePath)
                let config = InitConfig(
                    dbPath: self.resolvePath(dbPath),
                    workspacePath: resolvedWorkspacePath,
                    authProfilesPath: self.resolvePath(authProfilesPath)
                )
                let h = try NativeAgentHandle(config: config)
                try h.setEventCallback(callback: NativeAgentEventBridge(plugin: self))
                try h.setNotifier(notifier: NativeNotifierImpl())
                if let memoryProvider = MemoryProviderImpl.makeIfAvailable() {
                    try h.setMemoryProvider(provider: memoryProvider)
                }
                try h.persistConfig()
                self.handle = h
                UserDefaults.standard.set(
                    self.resolveConfigPath(workspacePath: resolvedWorkspacePath),
                    forKey: Self.configPathKey
                )
                call.resolve()
            } catch {
                call.reject("Failed to initialize NativeAgent: \(error.localizedDescription)")
            }
        }
    }

    // ── Agent ────────────────────────────────────────────────────────────────

    @objc func sendMessage(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let prompt = call.getString("prompt") else {
                return call.reject("prompt is required")
            }
            guard let sessionKey = call.getString("sessionKey") else {
                return call.reject("sessionKey is required")
            }

            do {
                let params = SendMessageParams(
                    prompt: prompt,
                    sessionKey: sessionKey,
                    model: call.getString("model"),
                    provider: call.getString("provider"),
                    systemPrompt: call.getString("systemPrompt") ?? "",
                    maxTurns: call.getInt("maxTurns").map { UInt32($0) },
                    allowedToolsJson: call.getString("allowedToolsJson")
                )
                let runId = try h.sendMessage(params: params)
                call.resolve(["runId": runId])
            } catch {
                call.reject("sendMessage failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func followUp(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                try h.followUp(prompt: call.getString("prompt") ?? "")
                call.resolve()
            } catch {
                call.reject("followUp failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func abort(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                try h.abort()
                call.resolve()
            } catch {
                call.reject("abort failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func steer(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                try h.steer(text: call.getString("text") ?? "")
                call.resolve()
            } catch {
                call.reject("steer failed: \(error.localizedDescription)")
            }
        }
    }

    // ── Approval gate ────────────────────────────────────────────────────────

    @objc func respondToApproval(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let toolCallId = call.getString("toolCallId") else {
                return call.reject("toolCallId is required")
            }
            do {
                try h.respondToApproval(
                    toolCallId: toolCallId,
                    approved: call.getBool("approved") ?? true,
                    reason: call.getString("reason")
                )
                call.resolve()
            } catch {
                call.reject("respondToApproval failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func respondToMcpTool(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let toolCallId = call.getString("toolCallId") else {
                return call.reject("toolCallId is required")
            }
            do {
                try h.respondToMcpTool(
                    toolCallId: toolCallId,
                    resultJson: call.getString("resultJson") ?? "null",
                    isError: call.getBool("isError") ?? false
                )
                call.resolve()
            } catch {
                call.reject("respondToMcpTool failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func respondToCronApproval(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let requestId = call.getString("requestId") else {
                return call.reject("requestId is required")
            }
            do {
                try h.respondToCronApproval(
                    requestId: requestId,
                    approved: call.getBool("approved") ?? false
                )
                call.resolve()
            } catch {
                call.reject("respondToCronApproval failed: \(error.localizedDescription)")
            }
        }
    }

    // ── Auth ─────────────────────────────────────────────────────────────────

    @objc func getAuthToken(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                let result = try h.getAuthToken(provider: call.getString("provider") ?? "anthropic")
                call.resolve([
                    "apiKey": result.apiKey as Any,
                    "isOAuth": result.isOauth,
                ])
            } catch {
                call.reject("getAuthToken failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func setAuthKey(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let key = call.getString("key") else {
                return call.reject("key is required")
            }
            do {
                try h.setAuthKey(
                    key: key,
                    provider: call.getString("provider") ?? "anthropic",
                    authType: call.getString("authType") ?? "api_key"
                )
                call.resolve()
            } catch {
                call.reject("setAuthKey failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func deleteAuth(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                try h.deleteAuth(provider: call.getString("provider") ?? "anthropic")
                call.resolve()
            } catch {
                call.reject("deleteAuth failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func refreshToken(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                let result = try h.refreshToken(provider: call.getString("provider") ?? "anthropic")
                call.resolve([
                    "apiKey": result.apiKey as Any,
                    "isOAuth": result.isOauth,
                ])
            } catch {
                call.reject("refreshToken failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func getAuthStatus(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                let result = try h.getAuthStatus(provider: call.getString("provider") ?? "anthropic")
                call.resolve([
                    "hasKey": result.hasKey,
                    "masked": result.masked,
                    "provider": result.provider,
                ])
            } catch {
                call.reject("getAuthStatus failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func exchangeOAuthCode(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let tokenUrl = call.getString("tokenUrl") else {
                return call.reject("tokenUrl is required")
            }
            guard let bodyJson = call.getString("bodyJson") else {
                return call.reject("bodyJson is required")
            }
            do {
                let resultJson = try h.exchangeOauthCode(
                    tokenUrl: tokenUrl,
                    bodyJson: bodyJson,
                    contentType: call.getString("contentType")
                )
                // Parse the JSON string into a dictionary and resolve
                if let data = resultJson.data(using: .utf8),
                   let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    call.resolve(dict)
                } else {
                    call.resolve(["resultJson": resultJson])
                }
            } catch {
                call.reject("exchangeOAuthCode failed: \(error.localizedDescription)")
            }
        }
    }

    // ── Sessions ─────────────────────────────────────────────────────────────

    @objc func listSessions(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                let json = try h.listSessions(agentId: call.getString("agentId") ?? "main")
                call.resolve(["sessionsJson": json])
            } catch {
                call.reject("listSessions failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func loadSession(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let sessKey = call.getString("sessionKey") else {
                return call.reject("sessionKey is required")
            }
            do {
                let json = try h.loadSession(sessionKey: sessKey)
                call.resolve([
                    "sessionKey": sessKey,
                    "messagesJson": json,
                ])
            } catch {
                call.reject("loadSession failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func resumeSession(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let sessKey = call.getString("sessionKey") else {
                return call.reject("sessionKey is required")
            }
            do {
                try h.resumeSession(
                    sessionKey: sessKey,
                    agentId: call.getString("agentId") ?? "main",
                    messagesJson: call.getString("messagesJson"),
                    provider: call.getString("provider"),
                    model: call.getString("model")
                )
                call.resolve()
            } catch {
                call.reject("resumeSession failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func clearSession(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                try h.clearSession()
                call.resolve()
            } catch {
                call.reject("clearSession failed: \(error.localizedDescription)")
            }
        }
    }

    // ── Cron / heartbeat ─────────────────────────────────────────────────────

    @objc func addCronJob(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let inputJson = call.getString("inputJson") else {
                return call.reject("inputJson is required")
            }
            do {
                let json = try h.addCronJob(inputJson: inputJson)
                call.resolve(["recordJson": json])
            } catch {
                call.reject("addCronJob failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func updateCronJob(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let id = call.getString("id") else {
                return call.reject("id is required")
            }
            do {
                try h.updateCronJob(id: id, patchJson: call.getString("patchJson") ?? "{}")
                call.resolve()
            } catch {
                call.reject("updateCronJob failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func removeCronJob(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let id = call.getString("id") else {
                return call.reject("id is required")
            }
            do {
                try h.removeCronJob(id: id)
                call.resolve()
            } catch {
                call.reject("removeCronJob failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func listCronJobs(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                call.resolve(["jobsJson": try h.listCronJobs()])
            } catch {
                call.reject("listCronJobs failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func runCronJob(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let jobId = call.getString("jobId") else {
                return call.reject("jobId is required")
            }
            do {
                try h.runCronJob(jobId: jobId)
                call.resolve()
            } catch {
                call.reject("runCronJob failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func listCronRuns(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                let json = try h.listCronRuns(
                    jobId: call.getString("jobId"),
                    limit: Int64(call.getInt("limit") ?? 100)
                )
                call.resolve(["runsJson": json])
            } catch {
                call.reject("listCronRuns failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func handleWake(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                try h.handleWake(source: call.getString("source") ?? "unknown")
                call.resolve()
            } catch {
                call.reject("handleWake failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func getSchedulerConfig(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                let schedulerJson = try h.getSchedulerConfig()
                let heartbeatJson = try h.getHeartbeatConfig()
                call.resolve([
                    "schedulerJson": schedulerJson,
                    "heartbeatJson": heartbeatJson,
                ])
            } catch {
                call.reject("getSchedulerConfig failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func setSchedulerConfig(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                try h.setSchedulerConfig(configJson: call.getString("configJson") ?? "{}")
                call.resolve()
            } catch {
                call.reject("setSchedulerConfig failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func setHeartbeatConfig(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                try h.setHeartbeatConfig(configJson: call.getString("configJson") ?? "{}")
                call.resolve()
            } catch {
                call.reject("setHeartbeatConfig failed: \(error.localizedDescription)")
            }
        }
    }

    // ── Skills ───────────────────────────────────────────────────────────────

    @objc func addSkill(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let inputJson = call.getString("inputJson") else {
                return call.reject("inputJson is required")
            }
            do {
                let json = try h.addSkill(inputJson: inputJson)
                call.resolve(["recordJson": json])
            } catch {
                call.reject("addSkill failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func updateSkill(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let id = call.getString("id") else {
                return call.reject("id is required")
            }
            do {
                try h.updateSkill(id: id, patchJson: call.getString("patchJson") ?? "{}")
                call.resolve()
            } catch {
                call.reject("updateSkill failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func removeSkill(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let id = call.getString("id") else {
                return call.reject("id is required")
            }
            do {
                try h.removeSkill(id: id)
                call.resolve()
            } catch {
                call.reject("removeSkill failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func listSkills(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                call.resolve(["skillsJson": try h.listSkills()])
            } catch {
                call.reject("listSkills failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func startSkill(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let skillId = call.getString("skillId") else {
                return call.reject("skillId is required")
            }
            do {
                let sessKey = try h.startSkill(
                    skillId: skillId,
                    configJson: call.getString("configJson") ?? "{}",
                    provider: call.getString("provider")
                )
                call.resolve(["sessionKey": sessKey])
            } catch {
                call.reject("startSkill failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func endSkill(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let skillId = call.getString("skillId") else {
                return call.reject("skillId is required")
            }
            do {
                try h.endSkill(skillId: skillId)
                call.resolve()
            } catch {
                call.reject("endSkill failed: \(error.localizedDescription)")
            }
        }
    }

    // ── Tool Permissions ──────────────────────────────────────────────────────

    @objc func seedToolPermissions(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let defaultsJson = call.getString("defaultsJson") else {
                return call.reject("defaultsJson is required")
            }
            do {
                let count = try h.seedToolPermissions(defaultsJson: defaultsJson)
                call.resolve(["seeded": Int(count)])
            } catch {
                call.reject("seedToolPermissions failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func setToolPermission(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let toolName = call.getString("toolName"),
                  let permission = call.getString("permission") else {
                return call.reject("toolName and permission are required")
            }
            let enabled = call.getBool("enabled") ?? true
            do {
                try h.setToolPermission(toolName: toolName, permission: permission, enabled: enabled)
                call.resolve()
            } catch {
                call.reject("setToolPermission failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func listToolPermissions(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                call.resolve(["permissionsJson": try h.listToolPermissions()])
            } catch {
                call.reject("listToolPermissions failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func resetToolPermissions(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                try h.resetToolPermissions()
                call.resolve()
            } catch {
                call.reject("resetToolPermissions failed: \(error.localizedDescription)")
            }
        }
    }

    // ── MCP ──────────────────────────────────────────────────────────────────

    @objc func startMcp(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                let count = try h.startMcp(toolsJson: call.getString("toolsJson") ?? "[]")
                call.resolve(["toolCount": Int(count)])
            } catch {
                call.reject("startMcp failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func restartMcp(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                let count = try h.restartMcp(toolsJson: call.getString("toolsJson") ?? "[]")
                call.resolve(["toolCount": Int(count)])
            } catch {
                call.reject("restartMcp failed: \(error.localizedDescription)")
            }
        }
    }

    // ── Models ───────────────────────────────────────────────────────────────

    @objc func getModels(_ call: CAPPluginCall) {
        withHandle(call) { h in
            do {
                let json = try h.getModels(provider: call.getString("provider") ?? "anthropic")
                call.resolve(["modelsJson": json])
            } catch {
                call.reject("getModels failed: \(error.localizedDescription)")
            }
        }
    }

    // ── Tools ────────────────────────────────────────────────────────────────

    @objc func invokeTool(_ call: CAPPluginCall) {
        withHandle(call) { h in
            guard let toolName = call.getString("toolName") else {
                return call.reject("toolName is required")
            }
            do {
                let resultJson = try h.invokeTool(
                    toolName: toolName,
                    argsJson: call.getString("argsJson") ?? "{}"
                )
                call.resolve(["resultJson": resultJson])
            } catch {
                call.reject("invokeTool failed: \(error.localizedDescription)")
            }
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Wraps the global UniFFI `initWorkspace(config:)` to avoid Swift name
/// collision with the `@objc func initWorkspace(_ call:)` instance method.
private func callInitWorkspace(config: InitConfig) throws {
    try initWorkspace(config: config)
}

// ── Event bridge ─────────────────────────────────────────────────────────────

/// Bridges Rust NativeEventCallback → Capacitor notifyListeners
class NativeAgentEventBridge: NativeEventCallback {
    private weak var plugin: NativeAgentPlugin?

    init(plugin: NativeAgentPlugin) {
        self.plugin = plugin
    }

    func onEvent(eventType: String, payloadJson: String) {
        plugin?.notifyListeners("nativeAgentEvent", data: [
            "eventType": eventType,
            "payloadJson": payloadJson,
        ])
    }
}
