package com.t6x.plugins.nativeagent

import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.native_agent_ffi.InitConfig
import uniffi.native_agent_ffi.NativeAgentHandle

@CapacitorPlugin(name = "NativeAgent")
class NativeAgentPlugin : Plugin() {

    private val job = SupervisorJob()
    private val scope = CoroutineScope(Dispatchers.IO + job)

    // ── Helper: wrap common pattern ────────────────────────────────────

    private fun withHandle(call: PluginCall, block: (NativeAgentHandle) -> Unit) {
        if (!job.isActive) {
            call.reject("NativeAgent plugin is shutting down — this call was dropped")
            return
        }
        val h = NativeAgentRegistry.get() ?: return call.reject("NativeAgent not initialized — call initialize() first")
        scope.launch {
            try {
                block(h)
            } catch (e: OutOfMemoryError) {
                throw e
            } catch (t: Throwable) {
                // Throwable, not Exception: UniFFI/JNA surface can throw
                // Errors (e.g. UnsatisfiedLinkError on an ABI without the
                // .so). Those must become a clean JS reject, not a crash —
                // an uncaught Error would kill the scope and leave every
                // subsequent JS promise hanging forever.
                call.reject("${call.methodName} failed: ${t.message ?: t::class.java.simpleName}", t as? Exception)
            }
        }
    }

    // ── Diagnostics ─────────────────────────────────────────────────────

    /**
     * Probes whether the native library is loadable on this device ABI.
     * Safe to call before initialize(); never crashes — a missing
     * libnative_agent_ffi.so for the current architecture (e.g. a 32-bit
     * device when only arm64-v8a was shipped) resolves with
     * `available: false` so the app can show a friendly message.
     */
    @PluginMethod
    fun checkAvailability(call: PluginCall) {
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
        val ret = JSObject()
        ret.put("abi", abi)
        ret.put("is64Bit", Build.SUPPORTED_64_BIT_ABIS.isNotEmpty())
        try {
            // Forces <clinit> of the JNA-registered FFI library. If the .so
            // for this ABI is not in the package, Native.register throws
            // UnsatisfiedLinkError here and nowhere else.
            Class.forName("uniffi.native_agent_ffi.IntegrityCheckingUniffiLib")
            ret.put("available", true)
            ret.put("reason", "")
        } catch (t: Throwable) {
            ret.put("available", false)
            ret.put("reason", "native library not loadable on ABI '$abi': ${t.message ?: t::class.java.simpleName}")
        }
        call.resolve(ret)
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    @PluginMethod
    fun initWorkspace(call: PluginCall) {
        val dbPath = call.getString("dbPath")
            ?: return call.reject("dbPath is required")
        val workspacePath = call.getString("workspacePath")
            ?: return call.reject("workspacePath is required")
        val authProfilesPath = call.getString("authProfilesPath")
            ?: return call.reject("authProfilesPath is required")
        val defaultProvider = call.getString("defaultProvider")
        val defaultModel = call.getString("defaultModel")

        scope.launch {
            try {
                uniffi.native_agent_ffi.initWorkspace(
                    InitConfig(
                        dbPath = resolvePath(dbPath),
                        workspacePath = resolvePath(workspacePath),
                        authProfilesPath = resolvePath(authProfilesPath),
                        defaultProvider = defaultProvider,
                        defaultModel = defaultModel,
                    )
                )
                call.resolve()
            } catch (e: OutOfMemoryError) {
                throw e
            } catch (t: Throwable) {
                call.reject("initWorkspace failed: ${t.message ?: t::class.java.simpleName}", t as? Exception)
            }
        }
    }

    @PluginMethod
    fun initialize(call: PluginCall) {
        val dbPath = call.getString("dbPath")
            ?: return call.reject("dbPath is required")
        val workspacePath = call.getString("workspacePath")
            ?: return call.reject("workspacePath is required")
        val authProfilesPath = call.getString("authProfilesPath")
            ?: return call.reject("authProfilesPath is required")
        val defaultProvider = call.getString("defaultProvider")
        val defaultModel = call.getString("defaultModel")

        scope.launch {
            try {
                val config = InitConfig(
                    dbPath = resolvePath(dbPath),
                    workspacePath = resolvePath(workspacePath),
                    authProfilesPath = resolvePath(authProfilesPath),
                    defaultProvider = defaultProvider,
                    defaultModel = defaultModel,
                )
                // Process-wide singleton: re-initializing closes the previous
                // handle explicitly (no GC-timing races, no double DB handles).
                NativeAgentRegistry.initialize(
                    context.applicationContext,
                    config,
                    object : NativeEventListener {
                        override fun onEvent(eventType: String, payloadJson: String) {
                            val data = JSObject()
                            data.put("eventType", eventType)
                            data.put("payloadJson", payloadJson)
                            notifyListeners("nativeAgentEvent", data)
                        }
                    },
                )
                call.resolve()
            } catch (e: OutOfMemoryError) {
                throw e
            } catch (t: Throwable) {
                val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
                val linkError = t is java.lang.UnsatisfiedLinkError ||
                    t.cause is java.lang.UnsatisfiedLinkError ||
                    (t.message ?: "").contains("native_agent_ffi")
                val msg = if (linkError) {
                    "Failed to load the native library on ABI '$abi'. The package is missing " +
                        "libnative_agent_ffi.so for this architecture — run scripts/build-android.sh " +
                        "(builds arm64-v8a, armeabi-v7a, x86, x86_64) and rebuild the app."
                } else {
                    "Failed to initialize NativeAgent: ${t.message ?: t::class.java.simpleName}"
                }
                android.util.Log.w("NativeAgent", msg)
                call.reject(msg, t as? Exception)
            }
        }
    }

    // ── Background wakes (framework JobScheduler; no androidx) ─────────

    @PluginMethod
    fun scheduleBackgroundWakes(call: PluginCall) {
        val intervalMinutes = call.getInt("intervalMinutes") ?: 30
        val ret = JSObject()
        if (!NativeAgentRegistry.isInitialized()) {
            ret.put("jobScheduled", false)
            ret.put("intervalMinutes", intervalMinutes)
            ret.put("reason", "NativeAgent not initialized yet — call initialize() first so its config can be restored in the background")
            call.resolve(ret)
            return
        }
        try {
            val result = NativeAgentSchedule.schedulePeriodicWakes(context.applicationContext, intervalMinutes)
            ret.put("jobScheduled", true)
            ret.put("intervalMinutes", result.effectiveIntervalMinutes)
            call.resolve(ret)
        } catch (t: Throwable) {
            ret.put("jobScheduled", false)
            ret.put("intervalMinutes", intervalMinutes)
            ret.put("reason", t.message ?: "failed to schedule background wakes")
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun cancelBackgroundWakes(call: PluginCall) {
        val ret = JSObject()
        try {
            ret.put("cancelled", NativeAgentSchedule.cancelWakes(context.applicationContext))
        } catch (t: Throwable) {
            ret.put("cancelled", false)
        }
        call.resolve(ret)
    }

    // ── Governance (native-to-native, not a @PluginMethod) ──────────

    /**
     * Register an optional governance provider for taint, audit, loop-guard, and cost tracking.
     * Called by capacitor-agent-os at init time — not exposed to JavaScript.
     */
    fun registerGovernance(provider: uniffi.native_agent_ffi.GovernanceProvider) {
        NativeAgentRegistry.get()?.setGovernanceProvider(provider)
    }

    // ── Agent ───────────────────────────────────────────────────────────

    @PluginMethod
    fun sendMessage(call: PluginCall) = withHandle(call) { h ->
        val sessionKey = call.getString("sessionKey") ?: return@withHandle call.reject("sessionKey is required")
        trace("sendMessage sessionKey=$sessionKey")
        val params = uniffi.native_agent_ffi.SendMessageParams(
            prompt = call.getString("prompt") ?: return@withHandle call.reject("prompt is required"),
            sessionKey = sessionKey,
            model = call.getString("model"),
            provider = call.getString("provider"),
            systemPrompt = call.getString("systemPrompt") ?: "",
            maxTurns = call.getInt("maxTurns")?.toUInt(),
            skillAllowedToolsJson = call.getString("skillAllowedToolsJson"),
            priorMessagesJson = call.getString("priorMessagesJson"),
        )
        val runId = h.sendMessage(params)
        trace("sendMessage OK runId=$runId")
        val ret = JSObject()
        ret.put("runId", runId)
        call.resolve(ret)
    }

    @PluginMethod
    fun followUp(call: PluginCall) = withHandle(call) { h ->
        val prompt = call.getString("prompt") ?: ""
        trace("followUp prompt_len=${prompt.length}")
        h.followUp(prompt)
        trace("followUp OK")
        call.resolve()
    }

    @PluginMethod
    fun abort(call: PluginCall) = withHandle(call) { h ->
        h.abort()
        call.resolve()
    }

    @PluginMethod
    fun steer(call: PluginCall) = withHandle(call) { h ->
        h.steer(call.getString("text") ?: "")
        call.resolve()
    }

    // ── Approval gate ───────────────────────────────────────────────────

    @PluginMethod
    fun respondToApproval(call: PluginCall) = withHandle(call) { h ->
        h.respondToApproval(
            call.getString("toolCallId") ?: return@withHandle call.reject("toolCallId is required"),
            call.getBoolean("approved") ?: true,
            call.getString("reason"),
        )
        call.resolve()
    }

    @PluginMethod
    fun respondToMcpTool(call: PluginCall) = withHandle(call) { h ->
        h.respondToMcpTool(
            call.getString("toolCallId") ?: return@withHandle call.reject("toolCallId is required"),
            call.getString("resultJson") ?: "null",
            call.getBoolean("isError") ?: false,
        )
        call.resolve()
    }

    @PluginMethod
    fun setMcpTools(call: PluginCall) = withHandle(call) { h ->
        val toolsJson = call.getString("toolsJson") ?: return@withHandle call.reject("toolsJson is required")
        val count = h.setMcpTools(toolsJson).toInt()
        val result = JSObject()
        result.put("count", count)
        call.resolve(result)
    }

    @PluginMethod
    fun respondToCronApproval(call: PluginCall) = withHandle(call) { h ->
        h.respondToCronApproval(
            call.getString("requestId") ?: return@withHandle call.reject("requestId is required"),
            call.getBoolean("approved") ?: false,
        )
        call.resolve()
    }

    // ── Auth ──────────────────────────────────────────────────────────

    @PluginMethod
    fun getAuthToken(call: PluginCall) = withHandle(call) { h ->
        val result = h.getAuthToken(call.getString("provider") ?: "anthropic")
        val ret = JSObject()
        ret.put("apiKey", result.apiKey)
        ret.put("isOAuth", result.isOauth)
        call.resolve(ret)
    }

    @PluginMethod
    fun setAuthKey(call: PluginCall) = withHandle(call) { h ->
        h.setAuthKey(
            call.getString("key") ?: return@withHandle call.reject("key is required"),
            call.getString("provider") ?: "anthropic",
            call.getString("authType") ?: "api_key",
            call.getString("refresh"),
            if (call.hasOption("expiresAt")) call.getLong("expiresAt") else null,
        )
        call.resolve()
    }

    @PluginMethod
    fun deleteAuth(call: PluginCall) = withHandle(call) { h ->
        h.deleteAuth(call.getString("provider") ?: "anthropic")
        call.resolve()
    }

    @PluginMethod
    fun refreshToken(call: PluginCall) = withHandle(call) { h ->
        val result = h.refreshToken(call.getString("provider") ?: "anthropic")
        val ret = JSObject()
        ret.put("apiKey", result.apiKey)
        ret.put("isOAuth", result.isOauth)
        call.resolve(ret)
    }

    @PluginMethod
    fun getAuthStatus(call: PluginCall) = withHandle(call) { h ->
        val result = h.getAuthStatus(call.getString("provider") ?: "anthropic")
        val ret = JSObject()
        ret.put("hasKey", result.hasKey)
        ret.put("masked", result.masked)
        ret.put("provider", result.provider)
        call.resolve(ret)
    }

    @PluginMethod
    fun exchangeOAuthCode(call: PluginCall) = withHandle(call) { h ->
        val tokenUrl = call.getString("tokenUrl") ?: return@withHandle call.reject("tokenUrl is required")
        val bodyJson = call.getString("bodyJson") ?: return@withHandle call.reject("bodyJson is required")
        val contentType = call.getString("contentType")
        val resultJson = h.exchangeOauthCode(tokenUrl, bodyJson, contentType)
        val ret = JSObject(resultJson)
        call.resolve(ret)
    }

    // ── Sessions ──────────────────────────────────────────────────────

    @PluginMethod
    fun listSessions(call: PluginCall) = withHandle(call) { h ->
        val agentId = call.getString("agentId") ?: "main"
        trace("listSessions agentId=$agentId")
        val json = h.listSessions(agentId)
        trace("listSessions result_len=${json.length}")
        val ret = JSObject()
        ret.put("sessionsJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun loadSession(call: PluginCall) = withHandle(call) { h ->
        val sessKey = call.getString("sessionKey") ?: return@withHandle call.reject("sessionKey is required")
        trace("loadSession sessionKey=$sessKey")
        val json = h.loadSession(sessKey)
        trace("loadSession result_len=${json.length}")
        val ret = JSObject()
        ret.put("sessionKey", sessKey)
        ret.put("messagesJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun resumeSession(call: PluginCall) = withHandle(call) { h ->
        val sessKey = call.getString("sessionKey") ?: return@withHandle call.reject("sessionKey is required")
        val agentId = call.getString("agentId") ?: "main"
        trace("resumeSession sessionKey=$sessKey agentId=$agentId")
        val wasInterrupted = h.resumeSession(
            sessKey,
            agentId,
            call.getString("messagesJson"),
            call.getString("provider"),
            call.getString("model"),
        )
        trace("resumeSession OK wasInterrupted=$wasInterrupted")
        val ret = JSObject()
        ret.put("wasInterrupted", wasInterrupted)
        call.resolve(ret)
    }

    @PluginMethod
    fun clearSession(call: PluginCall) = withHandle(call) { h ->
        h.clearSession()
        call.resolve()
    }

    // ── Cron / heartbeat ──────────────────────────────────────────────

    @PluginMethod
    fun addCronJob(call: PluginCall) = withHandle(call) { h ->
        val json = h.addCronJob(call.getString("inputJson") ?: return@withHandle call.reject("inputJson is required"))
        val ret = JSObject()
        ret.put("recordJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun updateCronJob(call: PluginCall) = withHandle(call) { h ->
        h.updateCronJob(
            call.getString("id") ?: return@withHandle call.reject("id is required"),
            call.getString("patchJson") ?: "{}",
        )
        call.resolve()
    }

    @PluginMethod
    fun removeCronJob(call: PluginCall) = withHandle(call) { h ->
        h.removeCronJob(call.getString("id") ?: return@withHandle call.reject("id is required"))
        call.resolve()
    }

    @PluginMethod
    fun listCronJobs(call: PluginCall) = withHandle(call) { h ->
        val ret = JSObject()
        ret.put("jobsJson", h.listCronJobs())
        call.resolve(ret)
    }

    @PluginMethod
    fun runCronJob(call: PluginCall) = withHandle(call) { h ->
        h.runCronJob(call.getString("jobId") ?: return@withHandle call.reject("jobId is required"))
        call.resolve()
    }

    @PluginMethod
    fun listCronRuns(call: PluginCall) = withHandle(call) { h ->
        val json = h.listCronRuns(
            call.getString("jobId"),
            (call.getInt("limit") ?: 100).toLong(),
        )
        val ret = JSObject()
        ret.put("runsJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun loadSurfacedMessages(call: PluginCall) = withHandle(call) { h ->
        val json = h.loadSurfacedMessages(
            (call.getInt("limit") ?: 50).toLong(),
        )
        val ret = JSObject()
        ret.put("messagesJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun handleWake(call: PluginCall) = withHandle(call) { h ->
        h.handleWake(call.getString("source") ?: "unknown")
        call.resolve()
    }

    @PluginMethod
    fun getSchedulerConfig(call: PluginCall) = withHandle(call) { h ->
        val schedulerJson = h.getSchedulerConfig()
        val heartbeatJson = h.getHeartbeatConfig()
        val ret = JSObject()
        ret.put("schedulerJson", schedulerJson)
        ret.put("heartbeatJson", heartbeatJson)
        call.resolve(ret)
    }

    @PluginMethod
    fun setSchedulerConfig(call: PluginCall) = withHandle(call) { h ->
        h.setSchedulerConfig(call.getString("configJson") ?: "{}")
        call.resolve()
    }

    @PluginMethod
    fun setHeartbeatConfig(call: PluginCall) = withHandle(call) { h ->
        h.setHeartbeatConfig(call.getString("configJson") ?: "{}")
        call.resolve()
    }

    // ── Skills ────────────────────────────────────────────────────────

    @PluginMethod
    fun addSkill(call: PluginCall) = withHandle(call) { h ->
        val json = h.addSkill(call.getString("inputJson") ?: return@withHandle call.reject("inputJson is required"))
        val ret = JSObject()
        ret.put("recordJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun updateSkill(call: PluginCall) = withHandle(call) { h ->
        h.updateSkill(
            call.getString("id") ?: return@withHandle call.reject("id is required"),
            call.getString("patchJson") ?: "{}",
        )
        call.resolve()
    }

    @PluginMethod
    fun removeSkill(call: PluginCall) = withHandle(call) { h ->
        h.removeSkill(call.getString("skillId") ?: return@withHandle call.reject("skillId is required"))
        call.resolve()
    }

    @PluginMethod
    fun listSkills(call: PluginCall) = withHandle(call) { h ->
        val ret = JSObject()
        ret.put("skillsJson", h.listSkills())
        call.resolve(ret)
    }

    @PluginMethod
    fun startSkill(call: PluginCall) = withHandle(call) { h ->
        val sessKey = h.startSkill(
            call.getString("skillId") ?: return@withHandle call.reject("skillId is required"),
            call.getString("configJson") ?: "{}",
            call.getString("provider"),
        )
        val ret = JSObject()
        ret.put("sessionKey", sessKey)
        call.resolve(ret)
    }

    @PluginMethod
    fun endSkill(call: PluginCall) = withHandle(call) { h ->
        h.endSkill(call.getString("skillId") ?: return@withHandle call.reject("skillId is required"))
        call.resolve()
    }

    // ── Tool Permissions ────────────────────────────────────────────

    @PluginMethod
    fun seedToolPermissions(call: PluginCall) = withHandle(call) { h ->
        val count = h.seedToolPermissions(
            call.getString("defaultsJson") ?: return@withHandle call.reject("defaultsJson is required")
        )
        val ret = JSObject()
        ret.put("seeded", count.toInt())
        call.resolve(ret)
    }

    @PluginMethod
    fun setToolPermission(call: PluginCall) = withHandle(call) { h ->
        h.setToolPermission(
            call.getString("toolName") ?: return@withHandle call.reject("toolName is required"),
            call.getString("permission") ?: return@withHandle call.reject("permission is required"),
            call.getBoolean("enabled") ?: true,
        )
        call.resolve()
    }

    @PluginMethod
    fun listToolPermissions(call: PluginCall) = withHandle(call) { h ->
        val ret = JSObject()
        ret.put("permissionsJson", h.listToolPermissions())
        call.resolve(ret)
    }

    @PluginMethod
    fun resetToolPermissions(call: PluginCall) = withHandle(call) { h ->
        h.resetToolPermissions()
        call.resolve()
    }

    // ── MCP ───────────────────────────────────────────────────────────

    @PluginMethod
    fun startMcp(call: PluginCall) = withHandle(call) { h ->
        val count = h.startMcp(call.getString("toolsJson") ?: "[]")
        val ret = JSObject()
        ret.put("toolCount", count.toInt())
        call.resolve(ret)
    }

    @PluginMethod
    fun restartMcp(call: PluginCall) = withHandle(call) { h ->
        val count = h.restartMcp(call.getString("toolsJson") ?: "[]")
        val ret = JSObject()
        ret.put("toolCount", count.toInt())
        call.resolve(ret)
    }

    // ── Models ────────────────────────────────────────────────────────

    @PluginMethod
    fun getModels(call: PluginCall) = withHandle(call) { h ->
        val json = h.getModels(call.getString("provider") ?: "anthropic")
        val ret = JSObject()
        ret.put("modelsJson", json)
        call.resolve(ret)
    }

    // ── Tools ─────────────────────────────────────────────────────────

    @PluginMethod
    fun invokeTool(call: PluginCall) = withHandle(call) { h ->
        val resultJson = h.invokeTool(
            call.getString("toolName") ?: return@withHandle call.reject("toolName is required"),
            call.getString("argsJson") ?: "{}",
        )
        val ret = JSObject()
        ret.put("resultJson", resultJson)
        call.resolve(ret)
    }

    // ── Cleanup ───────────────────────────────────────────────────────

    override fun handleOnDestroy() {
        // Cancel only THIS plugin instance's coroutines. The native handle is
        // process-wide (see NativeAgentRegistry) on purpose: background jobs
        // and other webview instances must keep working after one bridge is
        // torn down. The handle is released by the next initialize() or when
        // the process dies.
        scope.cancel()
    }

    // ── Path & logging helpers ─────────────────────────────────────────

    /**
     * Resolves `files://` URLs to absolute paths and makes sure the target
     * (or its parent) exists — matches the iOS plugin behavior, which the
     * old Android side was missing.
     */
    private fun resolvePath(path: String): String {
        val absolute = if (path.startsWith("files://")) {
            val rel = path.removePrefix("files://")
            "${context.filesDir.absolutePath}/$rel"
        } else {
            path
        }
        val file = java.io.File(absolute)
        if (file.extension.isEmpty()) {
            // Looks like a directory (e.g. workspace root): create it.
            file.mkdirs()
        } else {
            // Looks like a file (e.g. agent.db): create its parent.
            file.parentFile?.mkdirs()
        }
        return absolute
    }

    private fun trace(msg: String) {
        if (DEBUG) android.util.Log.i("TRACE:kt", msg)
    }

    private companion object {
        // TRACE logging leaks session keys into logcat; off by default.
        const val DEBUG = false
    }
}
