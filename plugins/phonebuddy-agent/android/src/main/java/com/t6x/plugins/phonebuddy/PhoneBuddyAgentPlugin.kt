package com.t6x.plugins.phonebuddy

import android.os.Build
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.sun.jna.Pointer
import com.sun.jna.ptr.PointerByReference
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Capacitor wrapper around the PhoneBuddy engine (public Apache-2.0 SDK).
 *
 * Scope: this plugin owns the two capabilities the pinned
 * `capacitor-native-agent` 0.5.2 build cannot provide — **background wakes** and
 * **surfaced messages** — plus the minimum engine control needed to produce
 * them (initialize / chat / sessions / host tools). The rest of the 44-method
 * agent API keeps working through the native-agent plugin; `bridge/nativekit.ts`
 * routes only these calls here, and falls back to its documented
 * "unsupported" envelope when this plugin (or the .so) is missing.
 *
 * Every method follows the crash-safety rule learned from the 0.9.x incident:
 * `catch (t: Throwable)` (an `UnsatisfiedLinkError` is an *Error*, so
 * `catch (Exception)` would let it kill the app) with an `OutOfMemoryError`
 * rethrow. `checkAvailability` never rejects.
 */
@CapacitorPlugin(name = "PhoneBuddyAgent")
class PhoneBuddyAgentPlugin : Plugin() {

    companion object {
        const val TAG = "PhoneBuddyAgent"
        const val ENGINE_GENERATION = "phonebuddy-0.2.0"
        const val EVENT_NAME = "phoneBuddyEvent"
        const val DEFAULT_SESSION = "main"

        /** Engine calls block; keep them off the WebView thread. */
        private val executor: ExecutorService = Executors.newSingleThreadExecutor { r ->
            Thread(r, "phonebuddy-engine")
        }

        @Volatile
        private var engine: Pointer? = null

        @Volatile
        private var activeChatSession: String? = null

        /** JNA callbacks are GC-managed: keep strong references for the process life. */
        private val callbacks = mutableListOf<Any>()
    }

    private val store by lazy { PhoneBuddyStore(context.applicationContext) }
    private val sandbox by lazy { store.rootDirOrDefault() }
    private val surfaced by lazy { PhoneBuddySurfaced(context.applicationContext, sandbox) }

    // ── Diagnostics ─────────────────────────────────────────────────────────

    @PluginMethod
    fun checkAvailability(call: PluginCall) {
        val ret = JSObject()
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
        val available = PhoneBuddyLib.isAvailable
        ret.put("abi", abi)
        ret.put("is64Bit", Build.SUPPORTED_64_BIT_ABIS.isNotEmpty())
        ret.put("available", available)
        ret.put("engineGeneration", ENGINE_GENERATION)
        if (available) {
            ret.put("version", PhoneBuddyFfi.version() ?: "unknown")
        } else {
            ret.put("reason", "libphone_buddy_ffi.so could not be loaded on ABI '$abi': ${PhoneBuddyLib.loadError ?: "unknown"}")
        }
        call.resolve(ret)
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    @PluginMethod
    fun initialize(call: PluginCall) {
        try {
            val lib = requireLib()
            val config = buildEngineConfig(call)
            val errOut = PointerByReference()
            val created = lib.pb_engine_new(config.json, errOut)
            if (created == null) {
                call.reject("pb_engine_new failed: ${lib.takeError(errOut) ?: "unknown error"}")
                return
            }
            engine?.let { lib.pb_engine_free(it) }
            engine = created

            // Persist everything the background wake needs to rebuild the engine.
            store.saveEngineConfig(config.json, config.rootDir)
            call.getString("toolsJson")?.let { store.saveHostTools(it) }

            val ret = JSObject()
            ret.put("initialized", true)
            ret.put("rootDir", config.rootDir.absolutePath)
            ret.put("model", config.model)
            ret.put("engineGeneration", ENGINE_GENERATION)
            ret.put("defaultsApplied", JSArray(config.defaultsApplied))
            call.resolve(ret)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            call.reject("initialize failed: ${t.message ?: t::class.java.simpleName}", asException(t))
        }
    }

    @PluginMethod
    fun shutdown(call: PluginCall) {
        try {
            engine?.let { PhoneBuddyLib.INSTANCE?.pb_engine_free(it) }
            engine = null
            activeChatSession = null
            call.resolve()
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            call.reject("shutdown failed: ${t.message ?: t::class.java.simpleName}", asException(t))
        }
    }

    // ── Chat ────────────────────────────────────────────────────────────────

    @PluginMethod
    fun sendMessage(call: PluginCall) {
        val sessionId = call.getString("sessionId") ?: DEFAULT_SESSION
        val text = call.getString("text")
        val turnJson = call.getString("turnJson")
        if (text.isNullOrBlank() && turnJson.isNullOrBlank()) {
            call.reject("sendMessage requires either 'text' or 'turnJson'")
            return
        }
        try {
            val lib = requireLib()
            val handle = engine ?: run { call.reject("engine is not initialized"); return }
            activeChatSession = sessionId
            executor.execute {
                try {
                    val errOut = PointerByReference()
                    val callback = newEventCallback(sessionId)
                    val resultPtr = if (!turnJson.isNullOrBlank()) {
                        lib.pb_engine_chat_v2(handle, sessionId, turnJson, callback, null, errOut)
                    } else {
                        lib.pb_engine_chat(handle, sessionId, text, callback, null, errOut)
                    }
                    val resultJson = lib.takeString(resultPtr)
                    val error = lib.takeError(errOut)
                    if (resultJson == null) {
                        call.reject("chat failed: ${error ?: "engine returned no result"}")
                        return@execute
                    }
                    val parsed = JSONObject(resultJson)
                    val ret = JSObject()
                    ret.put("sessionId", sessionId)
                    ret.put("finalText", parsed.optString("final_text", ""))
                    ret.put("turnsUsed", parsed.optInt("turns_used", 0))
                    parsed.optJSONObject("usage")?.let { ret.put("usageJson", it.toString()) }
                    ret.put("resultJson", resultJson)
                    call.resolve(ret)
                } catch (t: Throwable) {
                    call.reject("chat failed: ${t.message ?: t::class.java.simpleName}", asException(t))
                } finally {
                    activeChatSession = null
                }
            }
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            call.reject("sendMessage failed: ${t.message ?: t::class.java.simpleName}", asException(t))
        }
    }

    @PluginMethod
    fun abort(call: PluginCall) {
        try {
            val lib = requireLib()
            val handle = engine ?: run { call.resolve(); return }
            lib.pb_engine_cancel(handle, call.getString("sessionId") ?: activeChatSession ?: DEFAULT_SESSION)
            call.resolve()
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            call.reject("abort failed: ${t.message ?: t::class.java.simpleName}", asException(t))
        }
    }

    // ── Sessions ────────────────────────────────────────────────────────────

    @PluginMethod
    fun listSessions(call: PluginCall) = withEngine(call, "listSessions") { lib, handle ->
        val errOut = PointerByReference()
        val json = lib.takeString(lib.pb_engine_list_sessions(handle, errOut)) ?: "[]"
        val ret = JSObject()
        ret.put("sessionsJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun getSession(call: PluginCall) = withEngine(call, "getSession") { lib, handle ->
        val sessionId = call.getString("sessionId") ?: run { call.reject("sessionId is required"); return@withEngine }
        val errOut = PointerByReference()
        val json = lib.takeString(lib.pb_engine_get_session(handle, sessionId, errOut))
        if (json == null) {
            // Distinguish "no such session" (err_out left null by the SDK) from a
            // real failure, so the UI can show the right thing.
            val error = lib.takeError(errOut)
            if (error == null) {
                val ret = JSObject()
                ret.put("sessionJson", "null")
                call.resolve(ret)
            } else {
                call.reject("getSession failed for '$sessionId': $error")
            }
            return@withEngine
        }
        val ret = JSObject()
        ret.put("sessionJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun deleteSession(call: PluginCall) = withEngine(call, "deleteSession") { lib, handle ->
        val sessionId = call.getString("sessionId") ?: run { call.reject("sessionId is required"); return@withEngine }
        val code = lib.pb_engine_delete_session(handle, sessionId)
        val ret = JSObject()
        ret.put("deleted", code == 0)
        call.resolve(ret)
    }

    // ── Host tools ──────────────────────────────────────────────────────────

    @PluginMethod
    fun setHostTools(call: PluginCall) = withEngine(call, "setHostTools") { lib, handle ->
        val toolsJson = call.getString("toolsJson") ?: run { call.reject("toolsJson is required"); return@withEngine }
        val errOut = PointerByReference()
        val code = lib.pb_engine_set_host_tools(handle, toolsJson, errOut)
        if (code != 0) {
            call.reject("engine rejected the host tools: ${lib.takeError(errOut) ?: "unknown"}")
            return@withEngine
        }
        store.saveHostTools(toolsJson)
        val ret = JSObject()
        ret.put("ok", true)
        ret.put("engineGeneration", ENGINE_GENERATION)
        call.resolve(ret)
    }

    /**
     * Answers a host-tool call the engine routed to JS. Host *events*
     * (`notification_send`, `scheduler_registered`, …) are fire-and-forget and
     * must NOT be answered here.
     */
    @PluginMethod
    fun hostToolResult(call: PluginCall) = withEngine(call, "hostToolResult") { lib, handle ->
        val callId = call.getString("callId") ?: run { call.reject("callId is required"); return@withEngine }
        val ok = if (call.hasOption("ok")) call.getBoolean("ok") == true else true
        val output = call.getString("output") ?: ""
        val errOut = PointerByReference()
        val code = lib.pb_engine_host_tool_result(handle, callId, if (ok) 1 else 0, output, errOut)
        val ret = JSObject()
        ret.put("ok", code == 0)
        if (code != 0) ret.put("reason", lib.takeError(errOut) ?: "engine rejected the result")
        ret.put("engineGeneration", ENGINE_GENERATION)
        call.resolve(ret)
    }

    // ── Background wakes (the modern feature this plugin exists for) ─────────

    @PluginMethod
    fun scheduleBackgroundWakes(call: PluginCall) {
        val requested = call.getInt("intervalMinutes") ?: PhoneBuddyStore.DEFAULT_INTERVAL_MINUTES
        val ret = JSObject()
        try {
            val result = PhoneBuddySchedule.schedulePeriodicWakes(context.applicationContext, requested)
            store.saveWakeJob(result.jobScheduled, result.intervalMinutes)
            ret.put("jobScheduled", result.jobScheduled)
            ret.put("intervalMinutes", result.intervalMinutes)
            ret.put("engineGeneration", ENGINE_GENERATION)
            result.nextRunApproxMs?.let { ret.put("nextRunApproxMs", it.toDouble()) }
            result.reason?.let { ret.put("reason", it) }
            if (store.engineConfig() == null) {
                ret.put(
                    "reason",
                    "job armed, but the engine config was never persisted — call initialize() so the wake can rebuild the engine",
                )
            }
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            ret.put("jobScheduled", false)
            ret.put("intervalMinutes", requested)
            ret.put("engineGeneration", ENGINE_GENERATION)
            ret.put("reason", t.message ?: "could not schedule background wakes")
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun cancelBackgroundWakes(call: PluginCall) {
        val ret = JSObject()
        try {
            val had = PhoneBuddySchedule.cancelWakes(context.applicationContext)
            store.saveWakeJob(armed = false, intervalMinutes = store.wakeIntervalMinutes())
            ret.put("jobScheduled", false)
            ret.put("jobCancelled", had)
            ret.put("intervalMinutes", 0)
            ret.put("engineGeneration", ENGINE_GENERATION)
            if (!had) ret.put("reason", "no wake job was armed")
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            ret.put("jobScheduled", false)
            ret.put("engineGeneration", ENGINE_GENERATION)
            ret.put("reason", t.message ?: "could not cancel background wakes")
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun getWakeStatus(call: PluginCall) {
        val ret = JSObject()
        try {
            ret.put("jobScheduled", PhoneBuddySchedule.isArmed(context.applicationContext))
            ret.put("intervalMinutes", store.wakeIntervalMinutes())
            surfaced.lastWakeAt()?.let { ret.put("lastWakeAt", it) }
            surfaced.lastWakeSource()?.let { ret.put("lastWakeSource", it) }
            surfaced.lastWakeSummary()?.let { ret.put("lastWakeSummary", it) }
            ret.put("pendingTasks", PhoneBuddyWakeRunner.pendingTaskCount(sandbox))
            ret.put("engineGeneration", ENGINE_GENERATION)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            call.reject("getWakeStatus failed: ${t.message ?: t::class.java.simpleName}", asException(t))
            return
        }
        call.resolve(ret)
    }

    /**
     * Foreground catch-up: run the due tasks right now (cron-style entry point,
     * also what `NativeKit.agent.handleWake()` should call when the host has
     * already been woken by its own scheduler).
     */
    @PluginMethod
    fun handleWake(call: PluginCall) {
        val source = call.getString("source") ?: "manual"
        executor.execute {
            try {
                val result = PhoneBuddyWakeRunner.run(context.applicationContext, source = source, store = store)
                val ret = JSObject()
                ret.put("ran", result.ran)
                ret.put("summary", result.summary)
                ret.put("failures", JSArray(result.failures))
                ret.put("engineGeneration", ENGINE_GENERATION)
                call.resolve(ret)
            } catch (t: Throwable) {
                call.reject("handleWake failed: ${t.message ?: t::class.java.simpleName}", asException(t))
            }
        }
    }

    // ── Surfaced messages ───────────────────────────────────────────────────

    @PluginMethod
    fun loadSurfacedMessages(call: PluginCall) {
        val ret = JSObject()
        try {
            val limit = call.getInt("limit") ?: 50
            val markRead = call.getBoolean("markRead") == true
            val page = surfaced.load(limit, markRead)
            ret.put("messagesJson", page.messagesJson)
            ret.put("count", page.count)
            ret.put("unread", page.unread)
            ret.put("engineGeneration", ENGINE_GENERATION)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            ret.put("messagesJson", "[]")
            ret.put("count", 0)
            ret.put("unread", 0)
            ret.put("engineGeneration", ENGINE_GENERATION)
            ret.put("reason", t.message ?: "could not read surfaced messages")
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun clearSurfacedMessages(call: PluginCall) {
        val ret = JSObject()
        try {
            ret.put("cleared", surfaced.clear())
            ret.put("engineGeneration", ENGINE_GENERATION)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            call.reject("clearSurfacedMessages failed: ${t.message ?: t::class.java.simpleName}", asException(t))
            return
        }
        call.resolve(ret)
    }

    // ── Internals ───────────────────────────────────────────────────────────

    override fun handleOnDestroy() {
        try {
            engine?.let { PhoneBuddyLib.INSTANCE?.pb_engine_free(it) }
        } catch (t: Throwable) {
            Log.w(TAG, "engine free on destroy failed: ${t.message}")
        }
        engine = null
        super.handleOnDestroy()
    }

    private fun requireLib(): PhoneBuddyLib =
        PhoneBuddyLib.INSTANCE ?: throw IllegalStateException(
            "libphone_buddy_ffi.so is not loadable: ${PhoneBuddyLib.loadError ?: "unknown"}",
        )

    private inline fun withEngine(call: PluginCall, label: String, body: (PhoneBuddyLib, Pointer) -> Unit) {
        try {
            val lib = requireLib()
            val handle = engine ?: run { call.reject("engine is not initialized — call initialize() first"); return }
            body(lib, handle)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            call.reject("$label failed: ${t.message ?: t::class.java.simpleName}", asException(t))
        }
    }

    /**
     * PluginCall.reject() only accepts Exception, but the crash-safety paths
     * catch Throwable — wrap what is not already an Exception.
     */
    private fun asException(t: Throwable): Exception =
        t as? Exception ?: RuntimeException("${t::class.java.simpleName}: ${t.message}", t)

    /** Builds the EngineConfig JSON, filling in what the host omitted. */
    private class BuiltConfig(val json: String, val rootDir: File, val model: String, val defaultsApplied: List<String>)

    private fun buildEngineConfig(call: PluginCall): BuiltConfig {
        val defaults = mutableListOf<String>()
        val config = call.getString("configJson")?.let { JSONObject(it) } ?: JSONObject()

        fun ensure(key: String, value: Any?) {
            if (!config.has(key) || config.isNull(key)) {
                if (value != null) {
                    config.put(key, value)
                    defaults += key
                }
            }
        }

        val root = call.getString("rootDir")?.let(::File) ?: sandbox
        if (!config.has("root_dir")) {
            config.put("root_dir", root.absolutePath)
            defaults += "root_dir"
        }
        ensure("api_key", call.getString("apiKey"))
        ensure("base_url", call.getString("baseUrl"))
        ensure("model", call.getString("model"))
        ensure("locale", call.getString("locale"))
        ensure("agent_name", call.getString("agentName"))
        ensure("system_prompt_extra", call.getString("systemPromptExtra"))
        ensure("max_turns", call.getInt("maxTurns"))
        ensure("temperature", call.getDouble("temperature"))
        ensure("max_output_tokens", call.getInt("maxOutputTokens"))

        call.getObject("extra")?.let { extra ->
            for (key in extra.keys()) {
                if (!config.has(key)) config.put(key, extra.get(key))
            }
        }

        val model = config.optString("model", "")
        return BuiltConfig(config.toString(), root, model, defaults)
    }

    /** Streams engine events to JS as `phoneBuddyEvent`. */
    private fun newEventCallback(sessionId: String?): PbEventCallback {
        val callback = PbEventCallback { eventJson, _ ->
            try {
                if (!hasListeners(EVENT_NAME)) return@PbEventCallback
                val payload = eventJson ?: return@PbEventCallback
                // AgentEvent is an externally-tagged enum, so the single top-level
                // key IS the event name ("TextDelta", "ToolCallStart", …).
                val eventType = try {
                    val keys = JSONObject(payload).keys()
                    if (keys.hasNext()) keys.next() else "Unknown"
                } catch (t: Throwable) {
                    "Unknown"
                }
                val event = JSObject()
                event.put("eventType", eventType)
                event.put("payloadJson", payload)
                if (sessionId != null) event.put("sessionId", sessionId)
                notifyListeners(EVENT_NAME, event)
            } catch (t: Throwable) {
                Log.w(TAG, "event forwarding failed: ${t.message}")
            }
        }
        callbacks.add(callback)
        return callback
    }
}
