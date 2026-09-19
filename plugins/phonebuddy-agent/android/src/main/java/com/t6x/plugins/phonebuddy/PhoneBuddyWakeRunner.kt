package com.t6x.plugins.phonebuddy

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.sun.jna.Pointer
import com.sun.jna.ptr.PointerByReference
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Runs the agent headlessly and turns its output into surfaced messages.
 *
 * Called from two places:
 *  * [PhoneBuddyWakeService] — the periodic JobScheduler wake (app may be dead);
 *  * `PhoneBuddyAgentPlugin.handleWake()` — manual/cron catch-up in the foreground.
 *
 * What one wake does:
 *  1. rebuild the engine from the persisted config (nothing else survives);
 *  2. register the host-tool callback, because the engine delivers
 *     `notification_send` / `notification_schedule` / `monitor` /
 *     `scheduler_registered` / `scheduler_cancelled` through it;
 *  3. run every task in `scheduler.json` that is still `scheduled` by calling
 *     `pb_engine_chat()` with the task prompt;
 *  4. post an OS notification, append a **surfaced message**, and mark the task
 *     `completed` (rewriting `scheduler.json`, which is the engine's own file);
 *  5. free the engine and record wake telemetry for `getWakeStatus()`.
 *
 * Everything is wrapped in `catch (t: Throwable)` and reports failures as data —
 * a wake that fails must never take the process down, which is exactly the
 * contract the JS side relies on.
 */
internal object PhoneBuddyWakeRunner {

    private const val TAG = "PhoneBuddyWake"
    private const val CHANNEL_ID = "phonebuddy_agent"
    private const val CHANNEL_NAME = "PhoneBuddy agent"

    /** Host-event names the engine fires fire-and-forget (no result expected). */
    private val HOST_EVENTS = setOf(
        "scheduler_registered",
        "scheduler_cancelled",
        "notification_send",
        "notification_schedule",
        "monitor",
    )

    data class RunResult(
        val ran: Int,
        val summary: String,
        val failures: List<String> = emptyList(),
    )

    fun run(
        context: Context,
        source: String,
        store: PhoneBuddyStore = PhoneBuddyStore(context),
    ): RunResult {
        val surfaced = PhoneBuddySurfaced(context, store.rootDirOrDefault())
        val configJson = store.engineConfig()
        if (configJson.isNullOrBlank()) {
            val summary = "engine was never initialised — call initialize() so its config can be restored in the background"
            surfaced.recordWake(source, summary)
            return RunResult(0, summary)
        }
        if (!PhoneBuddyLib.isAvailable) {
            val summary = "libphone_buddy_ffi.so could not be loaded: ${PhoneBuddyLib.loadError ?: "unknown"}"
            surfaced.recordWake(source, summary)
            return RunResult(0, summary)
        }

        val lib = PhoneBuddyLib.INSTANCE ?: return RunResult(0, "engine library unavailable")
        val tasks = pendingTasks(store.rootDirOrDefault())
        if (tasks.isEmpty()) {
            val summary = "no scheduled tasks were due"
            surfaced.recordWake(source, summary)
            return RunResult(0, summary)
        }

        var engine: Pointer? = null
        val failures = mutableListOf<String>()
        var completedCount = 0
        try {
            val errOut = PointerByReference()
            engine = lib.pb_engine_new(configJson, errOut)
            if (engine == null) {
                val reason = lib.takeError(errOut) ?: "pb_engine_new returned null"
                surfaced.recordWake(source, "engine rebuild failed: $reason")
                return RunResult(0, "engine rebuild failed: $reason", listOf(reason))
            }

            store.hostTools()?.let { tools ->
                val toolsErr = PointerByReference()
                val rc = lib.pb_engine_set_host_tools(engine, tools, toolsErr)
                if (rc != 0) Log.w(TAG, "set_host_tools rejected: ${lib.takeError(toolsErr)}")
            }

            val bridgeContext = context
            val bridgeSurfaced = surfaced
            val toolCallback = PbHostToolCallback { callId, name, argumentsJson, _ ->
                handleHostToolCall(bridgeContext, bridgeSurfaced, name, argumentsJson, callId)
            }
            lib.pb_engine_set_host_callbacks(engine, null, toolCallback, null)
            KEEP_ALIVE.add(toolCallback) // JNA callbacks must outlive the call

            for (task in tasks) {
                val taskId = task.optString("id", "unknown")
                val prompt = task.optString("prompt", "").ifBlank { "Run the scheduled task $taskId" }
                val sessionId = task.optString("session", "sched-$taskId")
                try {
                    val err = PointerByReference()
                    val resultPtr = lib.pb_engine_chat(engine, sessionId, prompt, null, null, err)
                    val resultJson = lib.takeString(resultPtr)
                    val error = lib.takeError(err)
                    if (resultJson == null) {
                        failures += "$taskId: ${error ?: "engine returned no result"}"
                        continue
                    }
                    val finalText = try {
                        JSONObject(resultJson).optString("final_text", "")
                    } catch (t: Throwable) {
                        resultJson
                    }
                    val title = task.optString("title").ifBlank { "Scheduled task" }
                    surfaced.append(
                        source = source,
                        title = title,
                        text = finalText,
                        sessionId = sessionId,
                        taskId = taskId,
                    )
                    notify(context, title, finalText)
                    markTaskCompleted(store.rootDirOrDefault(), taskId)
                    completedCount++
                } catch (t: Throwable) {
                    failures += "$taskId: ${t::class.java.simpleName}: ${t.message ?: "unknown"}"
                }
            }

            val summary = buildString {
                append("ran ").append(completedCount).append(" of ").append(tasks.size).append(" scheduled task(s)")
                if (failures.isNotEmpty()) append("; failures: ").append(failures.size)
            }
            surfaced.recordWake(source, summary)
            return RunResult(completedCount, summary, failures)
        } catch (t: Throwable) {
            val summary = "wake failed: ${t::class.java.simpleName}: ${t.message ?: "unknown"}"
            Log.w(TAG, summary, t)
            surfaced.recordWake(source, summary)
            return RunResult(completedCount, summary, failures + summary)
        } finally {
            try {
                engine?.let { lib.pb_engine_free(it) }
            } catch (t: Throwable) {
                Log.w(TAG, "pb_engine_free failed: ${t.message}")
            }
        }
    }

    /** Handles one host callback: notifications become OS notifications + surfaced records. */
    private fun handleHostToolCall(
        context: Context,
        surfaced: PhoneBuddySurfaced,
        name: String?,
        argumentsJson: String?,
        callId: String?,
    ) {
        try {
            val toolName = name ?: return
            if (toolName !in HOST_EVENTS) {
                // A real host tool the app registered; without a JS bridge in the
                // background we cannot run it, so answer with a truthful failure
                // instead of leaving the engine waiting forever.
                PhoneBuddyLib.INSTANCE?.let { lib ->
                    val err = PointerByReference()
                    lib.pb_engine_host_tool_result(
                        null,
                        callId,
                        0,
                        "host tool '$toolName' is not available in a background wake",
                        err,
                    )
                }
                return
            }
            val payload = argumentsJson?.let { JSONObject(it) } ?: JSONObject()
            when (toolName) {
                "notification_send", "notification_schedule" -> {
                    val title = payload.optString("title", "PhoneBuddy")
                    val body = payload.optString("body", "")
                    surfaced.append(
                        source = "notification",
                        title = title,
                        body = body,
                    )
                    notify(context, title, body)
                }
                "monitor" -> {
                    surfaced.append(
                        source = "monitor",
                        title = payload.optString("title", "Monitor"),
                        body = payload.optString("message", payload.toString()),
                    )
                }
                else -> {
                    // scheduler_registered / scheduler_cancelled: the host is
                    // expected to (re)arm its OS scheduler — that is exactly why
                    // these events exist in the SDK.
                    surfaced.append(source = toolName, body = payload.toString())
                }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "host event handling failed: ${t.message}")
        }
    }

    private fun notify(context: Context, title: String, body: String) {
        try {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT),
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.Notification.Builder(context, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                android.app.Notification.Builder(context)
            }
            manager.notify(
                (System.currentTimeMillis() % Int.MAX_VALUE).toInt(),
                builder
                    .setContentTitle(title)
                    .setContentText(body.take(240))
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setAutoCancel(true)
                    .build(),
            )
        } catch (t: Throwable) {
            Log.w(TAG, "notification failed: ${t.message}")
        }
    }

    // ── scheduler.json (owned by the engine, rewritten here to mark progress) ──

    private fun schedulerFile(rootDir: File): File = File(rootDir, "scheduler.json")

    /** Tasks the engine still considers due. */
    fun pendingTasks(rootDir: File): List<JSONObject> = try {
        val f = schedulerFile(rootDir)
        if (!f.isFile) emptyList() else {
            val array = JSONArray(f.readText())
            (0 until array.length())
                .mapNotNull { array.optJSONObject(it) }
                .filter { it.optString("status", "scheduled") == "scheduled" }
        }
    } catch (t: Throwable) {
        emptyList()
    }

    fun pendingTaskCount(rootDir: File): Int = pendingTasks(rootDir).size

    /** Flips one task to `completed` in the engine's own store. */
    private fun markTaskCompleted(rootDir: File, taskId: String) {
        try {
            val f = schedulerFile(rootDir)
            if (!f.isFile) return
            val array = JSONArray(f.readText())
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                if (item.optString("id") == taskId) item.put("status", "completed")
            }
            f.writeText(array.toString())
        } catch (t: Throwable) {
            Log.w(TAG, "could not mark task $taskId completed: ${t.message}")
        }
    }

    /** Strong references to JNA callbacks for the lifetime of the process. */
    private val KEEP_ALIVE = mutableListOf<Any>()
}
