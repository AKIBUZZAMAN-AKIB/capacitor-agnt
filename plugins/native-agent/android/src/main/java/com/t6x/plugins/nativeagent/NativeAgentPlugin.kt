package com.t6x.plugins.nativeagent

import android.content.Context
import android.os.Build
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.sun.jna.Library
import com.sun.jna.Native
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.native_agent_ffi.InitConfig
import uniffi.native_agent_ffi.NativeAgentHandle
import uniffi.native_agent_ffi.NativeEventCallback
import uniffi.native_agent_ffi.SendMessageParams

@CapacitorPlugin(name = "NativeAgent")
class NativeAgentPlugin : Plugin() {

    private var handle: NativeAgentHandle? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    companion object {
        private const val TAG = "NativeAgentPlugin"
        private const val STORAGE_FILE = "CapacitorStorage"
        private const val CONFIG_PATH_KEY = "mobilecron:native-agent-config-path"

        /** Which public upstream generation this module was pinned to. */
        private const val ENGINE_GENERATION = "0.5.2-public"
    }

    // ── Helper: wrap common pattern ────────────────────────────────────

        /**
     * PluginCall.reject() only accepts Exception, but the crash-safety paths catch
     * Throwable (UnsatisfiedLinkError and friends are Errors). Wrap whatever is not
     * already an Exception so the JS side still gets the message and the cause.
     */
    private fun asException(t: Throwable): Exception =
        t as? Exception ?: RuntimeException("${t::class.java.simpleName}: ${t.message}", t)

private fun withHandle(call: PluginCall, block: (NativeAgentHandle) -> Unit) {
        val h = handle ?: return call.reject("NativeAgent not initialized — call initialize() first")
        scope.launch {
            try {
                block(h)
            } catch (t: Throwable) {
                // UnsatisfiedLinkError (missing .so for this ABI) is an Error, not an
                // Exception: without catching Throwable it escapes the coroutine and
                // kills the app. Backported crash-safety fix (0.9.x "C1").
                if (t is OutOfMemoryError) throw t
                call.reject("${call.methodName} failed: ${t.message ?: t::class.java.simpleName}", asException(t))
            }
        }
    }

    // ── Diagnostics ────────────────────────────────────────────────────

    /** JNA probe interface: we only care whether dlopen succeeds. */
    private interface NativeProbeLib : Library

    /**
     * Never rejects. Reports whether libnative_agent_ffi.so can be loaded on this
     * device's ABI, so the UI can hide agent features instead of failing later.
     * Backported from the 0.9.x plugin generation (it did not exist in 0.5.2).
     */
    @PluginMethod
    fun checkAvailability(call: PluginCall) {
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
        val ret = JSObject()
        ret.put("abi", abi)
        ret.put("is64Bit", Build.SUPPORTED_64_BIT_ABIS.isNotEmpty())
        ret.put("engineGeneration", ENGINE_GENERATION)
        try {
            // Same resolution uniffi uses when it loads its own bindings
            // (UniffiLib -> loadIndirect(componentName = "native_agent_ffi")).
            Native.load("native_agent_ffi", NativeProbeLib::class.java)
            ret.put("available", true)
            ret.put("reason", "")
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            ret.put("available", false)
            ret.put("reason", "native library not loadable on ABI '$abi': ${t.message ?: t::class.java.simpleName}")
        }
        call.resolve(ret)
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    @PluginMethod
    fun initWorkspace(call: PluginCall) {
        val dbPath = call.getString("dbPath")
            ?: return call.reject("dbPath is required")
        val workspacePath = call.getString("workspacePath")
            ?: return call.reject("workspacePath is required")
        val authProfilesPath = call.getString("authProfilesPath")
            ?: return call.reject("authProfilesPath is required")

        scope.launch {
            try {
                uniffi.native_agent_ffi.initWorkspace(
                    InitConfig(
                        dbPath = resolvePath(dbPath),
                        workspacePath = resolvePath(workspacePath),
                        authProfilesPath = resolvePath(authProfilesPath),
                    )
                )
                call.resolve()
            } catch (t: Throwable) {
                if (t is OutOfMemoryError) throw t
                call.reject("initWorkspace failed: ${t.message ?: t::class.java.simpleName}", asException(t))
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

        scope.launch {
            try {
                val resolvedWorkspacePath = resolvePath(workspacePath)
                val config = InitConfig(
                    dbPath = resolvePath(dbPath),
                    workspacePath = resolvedWorkspacePath,
                    authProfilesPath = resolvePath(authProfilesPath),
                )
                val h = NativeAgentHandle(config)
                h.setEventCallback(object : NativeEventCallback {
                    override fun onEvent(eventType: String, payloadJson: String) {
                        val data = JSObject()
                        data.put("eventType", eventType)
                        data.put("payloadJson", payloadJson)
                        notifyListeners("nativeAgentEvent", data)
                    }
                })
                h.setNotifier(NativeNotifierImpl(context.applicationContext))
                // Memory (LanceDB) is optional and its Kotlin class only exists when
                // the host app also integrates capacitor-lancedb, so it is wired
                // reflectively — no compile-time reference (0.9.x "C2" fix).
                runCatching {
                    val clazz = Class.forName("com.t6x.plugins.nativeagent.MemoryProviderImpl")
                    val instance = clazz.getConstructor(Context::class.java).newInstance(context.applicationContext)
                    val available = clazz.getMethod("isAvailable").invoke(instance) as? Boolean ?: false
                    if (available) {
                        h.setMemoryProvider(instance as uniffi.native_agent_ffi.MemoryProvider)
                    }
                }.onFailure { Log.w(TAG, "memory provider unavailable: ${it.message}") }
                h.persistConfig()
                handle = h
                context
                    .getSharedPreferences(STORAGE_FILE, android.content.Context.MODE_PRIVATE)
                    .edit()
                    .putString(CONFIG_PATH_KEY, resolveConfigPath(resolvedWorkspacePath))
                    .apply()
                call.resolve()
            } catch (t: Throwable) {
                if (t is OutOfMemoryError) throw t
                call.reject("Failed to initialize NativeAgent: ${t.message ?: t::class.java.simpleName}", asException(t))
            }
        }
    }

    // ── Agent ──────────────────────────────────────────────────────────

    @PluginMethod
    fun sendMessage(call: PluginCall) = withHandle(call) { h ->
        val params = SendMessageParams(
            prompt = call.getString("prompt") ?: return@withHandle call.reject("prompt is required"),
            sessionKey = call.getString("sessionKey") ?: return@withHandle call.reject("sessionKey is required"),
            model = call.getString("model"),
            provider = call.getString("provider"),
            systemPrompt = call.getString("systemPrompt") ?: "",
            maxTurns = call.getInt("maxTurns")?.toUInt(),
            allowedToolsJson = call.getString("allowedToolsJson"),
            priorMessagesJson = call.getString("priorMessagesJson"),
        )
        val runId = h.sendMessage(params)
        val ret = JSObject()
        ret.put("runId", runId)
        call.resolve(ret)
    }

    @PluginMethod
    fun followUp(call: PluginCall) = withHandle(call) { h ->
        h.followUp(call.getString("prompt") ?: "")
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

    // ── Approval gate ──────────────────────────────────────────────────

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
        val json = h.listSessions(call.getString("agentId") ?: "main")
        val ret = JSObject()
        ret.put("sessionsJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun loadSession(call: PluginCall) = withHandle(call) { h ->
        val sessKey = call.getString("sessionKey") ?: return@withHandle call.reject("sessionKey is required")
        val json = h.loadSession(sessKey)
        val ret = JSObject()
        ret.put("sessionKey", sessKey)
        ret.put("messagesJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun resumeSession(call: PluginCall) = withHandle(call) { h ->
        h.resumeSession(
            call.getString("sessionKey") ?: return@withHandle call.reject("sessionKey is required"),
            call.getString("agentId") ?: "main",
            call.getString("messagesJson"),
            call.getString("provider"),
            call.getString("model"),
        )
        call.resolve()
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
        h.removeSkill(call.getString("id") ?: return@withHandle call.reject("id is required"))
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
        scope.cancel()
        handle = null
    }

    private fun resolvePath(path: String): String {
        return if (path.startsWith("files://")) {
            val rel = path.removePrefix("files://")
            "${context.filesDir.absolutePath}/$rel"
        } else {
            path
        }
    }

    private fun resolveConfigPath(workspacePath: String): String {
        val workspace = java.io.File(workspacePath)
        val parent = workspace.parentFile ?: workspace
        return java.io.File(parent, ".native-agent-config.json").absolutePath
    }
}
