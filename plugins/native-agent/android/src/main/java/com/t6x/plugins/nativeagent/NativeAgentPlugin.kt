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
import org.json.JSONObject
import uniffi.native_agent_ffi.InitConfig
import uniffi.native_agent_ffi.NativeAgentHandle
import uniffi.native_agent_ffi.NativeEventCallback
import uniffi.native_agent_ffi.SendMessageParams

@CapacitorPlugin(name = "NativeAgent")
class NativeAgentPlugin : Plugin() {

    private var handle: NativeAgentHandle? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    companion object {
        // Shared with NativeWakeStore: the WorkManager worker runs in a process
        // with no WebView, so it must read exactly the keys initialize() wrote.
        private const val STORAGE_FILE = NativeWakeStore.CAPACITOR_STORAGE_FILE
        private const val CONFIG_PATH_KEY = NativeWakeStore.CONFIG_PATH_KEY

        /** Which public upstream generation this module was pinned to. */
        private const val ENGINE_GENERATION = "0.5.2-public"

        private const val LOG_TAG = "NativeAgentPlugin"
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
                // Long-term memory is part of the plugin: a file-backed store with
                // lexical search. It used to be reflective because the LanceDB
                // implementation was only compiled when the host app integrated the
                // capacitor-lancedb plugin — which this app never did, so the agent's
                // memory tools always answered "Memory provider not configured".
                // The built-in provider always exists, so it is wired directly: a
                // missing class can no longer silently disable the feature.
                h.setMemoryProvider(MemoryProviderImpl(context.applicationContext))
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

    /**
     * Foreground catch-up: runs every due cron job immediately, exactly like the
     * OS-initiated wake, and therefore surfaces its output the same way. Without
     * the capture step, "wake now" would silently run jobs whose answers never
     * reach `loadSurfacedMessages()`.
     */
    @PluginMethod
    fun handleWake(call: PluginCall) = withHandle(call) { h ->
        val appContext = context.applicationContext
        val source = call.getString("source") ?: "unknown"
        val startedAt = System.currentTimeMillis()
        NativeWakeCapture.installRecordingNotifier(appContext, h)
        try {
            h.handleWake(source)
        } finally {
            NativeWakeCapture.restoreDefaultNotifier(appContext, h)
        }
        val captured = NativeWakeCapture.capture(appContext, h, source, startedAt)
        NativeWakeStore(appContext).recordWake(source, captured.summary, captured.ran, true)
        val ret = JSObject()
        ret.put("ran", captured.ran)
        ret.put("failed", captured.failed)
        ret.put("surfaced", captured.surfaced)
        ret.put("summary", captured.summary)
        call.resolve(ret)
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

    // ── Background wakes ──────────────────────────────────────────────
    //
    // The engine can *run* a wake (`handle_wake` evaluates every due cron job)
    // but it cannot ask the OS for background runtime — that is the app's job,
    // and this is where the app does it. NativeWakeScheduler explains why
    // WorkManager; the limits below are reported instead of hidden.

    /**
     * Arms the periodic OS wake. The interval preference order is: the explicit
     * argument, then the engine's heartbeat interval, then the stored/default
     * value — and WorkManager floors it at 15 minutes, which the answer states.
     */
    @PluginMethod
    fun scheduleBackgroundWakes(call: PluginCall) {
        val appContext = context.applicationContext
        val store = NativeWakeStore(appContext)
        val h = handle
        var requiresCharging = false
        var schedulerEnabled: Boolean? = null
        var heartbeatMinutes: Int? = null
        if (h != null) {
            try {
                val scheduler = JSONObject(h.getSchedulerConfig())
                requiresCharging = scheduler.optBoolean("runOnCharging", false)
                schedulerEnabled = scheduler.optBoolean("enabled", true)
                val everyMs = JSONObject(h.getHeartbeatConfig()).optLong("everyMs", 0L)
                if (everyMs > 0) heartbeatMinutes = (everyMs / 60_000L).toInt().coerceAtLeast(1)
            } catch (t: Throwable) {
                if (t is OutOfMemoryError) throw t
                Log.w(LOG_TAG, "engine scheduler config unreadable: ${t.message}")
            }
        }

        val requested = call.getInt("intervalMinutes") ?: heartbeatMinutes ?: store.intervalMinutes

        scope.launch {
            val status = NativeWakeScheduler.schedule(appContext, requested, requiresCharging)
            val ret = JSObject()
            ret.put("jobScheduled", status.jobScheduled)
            ret.put("intervalMinutes", status.intervalMinutes)
            ret.put("requestedIntervalMinutes", requested)
            ret.put("requiresCharging", status.requiresCharging)
            ret.put("minIntervalMinutes", NativeWakeStore.MIN_INTERVAL_MINUTES)
            ret.put("engineGeneration", ENGINE_GENERATION)
            ret.put("platform", "android")
            ret.put("mechanism", "WorkManager PeriodicWorkRequest")
            ret.put("workName", NativeWakeScheduler.UNIQUE_WORK_NAME)
            heartbeatMinutes?.let { ret.put("heartbeatIntervalMinutes", it) }
            schedulerEnabled?.let { ret.put("schedulerEnabled", it) }
            status.nextRunApproxMs?.let { ret.put("nextRunApproxMs", it.toDouble()) }
            if (store.engineConfigPath() == null) {
                ret.put(
                    "reason",
                    "wake armed, but the engine config was never persisted — call initialize() so the background wake can rebuild the engine",
                )
            }
            status.reason?.let { ret.put("reason", it) }
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun cancelBackgroundWakes(call: PluginCall) {
        scope.launch {
            val status = NativeWakeScheduler.cancel(context.applicationContext)
            val ret = JSObject()
            ret.put("jobScheduled", false)
            ret.put("jobCancelled", status.reason == null)
            ret.put("intervalMinutes", 0)
            ret.put("engineGeneration", ENGINE_GENERATION)
            ret.put("platform", "android")
            status.reason?.let { ret.put("reason", it) }
            call.resolve(ret)
        }
    }

    /**
     * Real telemetry: the WorkManager state (not a stored wish), the last wake's
     * timestamp/source/outcome, and — when a handle exists — how many cron jobs
     * are enabled and how many are already due.
     */
    @PluginMethod
    fun getWakeStatus(call: PluginCall) {
        val appContext = context.applicationContext
        scope.launch {
            val store = NativeWakeStore(appContext)
            val status = NativeWakeScheduler.status(appContext)
            val ret = JSObject()
            ret.put("jobScheduled", status.jobScheduled)
            ret.put("intervalMinutes", status.intervalMinutes)
            ret.put("requiresCharging", status.requiresCharging)
            ret.put("minIntervalMinutes", NativeWakeStore.MIN_INTERVAL_MINUTES)
            ret.put("engineGeneration", ENGINE_GENERATION)
            ret.put("platform", "android")
            ret.put("mechanism", "WorkManager PeriodicWorkRequest")
            ret.put("workName", NativeWakeScheduler.UNIQUE_WORK_NAME)
            ret.put("workState", status.state ?: JSONObject.NULL)
            ret.put("runAttemptCount", status.runAttemptCount)
            ret.put("nextRunApproxMs", status.nextRunApproxMs?.toDouble() ?: JSONObject.NULL)
            ret.put("lastWakeAt", store.lastWakeAt ?: JSONObject.NULL)
            ret.put("lastWakeSource", store.lastWakeSource ?: JSONObject.NULL)
            ret.put("lastWakeSummary", store.lastWakeSummary ?: JSONObject.NULL)
            ret.put("lastWakeRan", store.lastWakeRan)
            ret.put("lastWakeOk", store.lastWakeOk)
            ret.put("unreadSurfaced", store.unreadCount())
            val h = handle
            ret.put("engineInitialized", h != null)
            ret.put("pendingTasks", JSONObject.NULL)
            ret.put("enabledCronJobs", JSONObject.NULL)
            ret.put("dueCronJobs", JSONObject.NULL)
            if (h != null) {
                try {
                    val cron = NativeWakeScheduler.cronSummary(h.listCronJobs())
                    ret.put("enabledCronJobs", cron.first)
                    ret.put("dueCronJobs", cron.second)
                    // Same meaning the previous generation's getWakeStatus gave
                    // `pendingTasks`: work that is still waiting to run.
                    ret.put("pendingTasks", cron.second)
                } catch (t: Throwable) {
                    if (t is OutOfMemoryError) throw t
                    Log.w(LOG_TAG, "could not read cron jobs: ${t.message}")
                }
            }
            status.reason?.let { ret.put("reason", it) }
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun loadSurfacedMessages(call: PluginCall) {
        val appContext = context.applicationContext
        val limit = (call.getInt("limit") ?: 50).coerceIn(1, NativeWakeStore.MAX_RECORDS)
        val markRead = call.getBoolean("markRead") ?: false
        scope.launch {
            val store = NativeWakeStore(appContext)
            val page = store.load(limit, markRead)
            val ret = JSObject()
            ret.put("messagesJson", page.messagesJson)
            ret.put("count", page.count)
            ret.put("unread", page.unread)
            ret.put("limit", limit)
            ret.put("markRead", markRead)
            ret.put("engineGeneration", ENGINE_GENERATION)
            ret.put("platform", "android")
            ret.put("lastWakeAt", store.lastWakeAt ?: JSONObject.NULL)
            ret.put("lastWakeSource", store.lastWakeSource ?: JSONObject.NULL)
            ret.put("lastWakeSummary", store.lastWakeSummary ?: JSONObject.NULL)
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun clearSurfacedMessages(call: PluginCall) {
        val appContext = context.applicationContext
        scope.launch {
            val store = NativeWakeStore(appContext)
            val cleared = store.clear()
            val ret = JSObject()
            ret.put("cleared", cleared)
            ret.put("unread", 0)
            ret.put("engineGeneration", ENGINE_GENERATION)
            ret.put("platform", "android")
            call.resolve(ret)
        }
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
