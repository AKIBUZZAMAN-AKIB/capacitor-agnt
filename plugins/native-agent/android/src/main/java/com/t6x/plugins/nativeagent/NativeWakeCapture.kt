package com.t6x.plugins.nativeagent

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import uniffi.native_agent_ffi.NativeAgentHandle

/**
 * Turns one finished wake into surfaced messages.
 *
 * The engine already did the hard part: `handle_wake(source)` wrote one
 * `cron_runs` row per due job, with `wake_source` set to exactly the string the
 * caller passed, plus `status`, `duration_ms`, `error`, `response_text` and
 * `delivered`. So a wake's output can be read back with `listCronRuns()` and
 * selected by `wakeSource` + `startedAt >= <wake start>` — no guessing, no
 * extra bookkeeping inside the engine, and the rows are the same ones
 * `listCronRuns()` shows in the UI. Anything else would be a second source of
 * truth that can drift from the engine's own history.
 *
 * Used by both wake paths:
 *  * [NativeWakeRunner] — cold start from the WorkManager worker (no WebView);
 *  * `NativeAgentPlugin.handleWake()` — foreground catch-up, which must surface
 *    its output too, otherwise "wake now" in the lab would look like it did
 *    nothing.
 */
internal object NativeWakeCapture {

    /** `source` value of records produced by a wake (the pre-existing contract). */
    const val SURFACED_SOURCE = "background"

    /** How many cron runs to scan when collecting this wake's output. */
    private const val RUN_SCAN_LIMIT = 200L

    /** Guard against a runaway model answer ending up in a JSON file. */
    private const val MAX_TEXT_CHARS = 8000
    private const val MAX_BODY_CHARS = 4000

    data class Captured(val ran: Int, val failed: Int, val surfaced: Int, val summary: String)

    /**
     * Wraps the notifier for the duration of a wake so that notifications the
     * engine posts are also persisted as surfaced messages.
     */
    fun installRecordingNotifier(context: Context, handle: NativeAgentHandle) {
        handle.setNotifier(NativeWakeNotifier(context.applicationContext, NativeWakeStore(context)))
    }

    /** Puts the plain notifier back after a foreground wake. */
    fun restoreDefaultNotifier(context: Context, handle: NativeAgentHandle) {
        handle.setNotifier(NativeNotifierImpl(context.applicationContext))
    }

    fun capture(
        context: Context,
        handle: NativeAgentHandle,
        source: String,
        startedAtMs: Long,
    ): Captured {
        val store = NativeWakeStore(context)
        val names = jobNames(handle)

        var ran = 0
        var failed = 0
        var surfaced = 0

        val runs = try {
            JSONArray(handle.listCronRuns(null, RUN_SCAN_LIMIT))
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            JSONArray()
        }

        for (i in 0 until runs.length()) {
            val run = runs.optJSONObject(i) ?: continue
            if (run.optString("wakeSource", "") != source) continue
            val startedAt = run.optLong("startedAt", 0L)
            if (startedAt < startedAtMs) continue

            val status = run.optString("status", "unknown")
            val jobId = normalized(run.optString("jobId", ""))
            val error = normalized(run.optString("error", ""))
            val text = normalized(run.optString("responseText", ""))
            val body = when {
                status == "error" -> error.ifBlank { "the job failed without an error message" }
                text.isBlank() -> "the job completed but the model returned no text"
                else -> text
            }
            val at = if (startedAt > 0) startedAt else System.currentTimeMillis()

            store.append(
                source = SURFACED_SOURCE,
                title = names[jobId] ?: jobId.ifBlank { "cron job" },
                body = body.take(MAX_BODY_CHARS),
                text = text.take(MAX_TEXT_CHARS),
                jobId = jobId.takeIf { it.isNotEmpty() },
                runId = run.optLong("id", -1L).takeIf { it >= 0 },
                status = status,
                delivered = boolField(run, "delivered"),
                at = at,
            )
            if (status == "ok") ran++ else failed++
            surfaced++
        }

        val summary = if (surfaced == 0) {
            "no cron job was due (source: $source)"
        } else {
            "ran $ran job(s), $failed failed (source: $source)"
        }
        return Captured(ran, failed, surfaced, summary)
    }

    /** jobId → job name, so a surfaced record has a human title. */
    private fun jobNames(handle: NativeAgentHandle): Map<String, String> {
        val names = HashMap<String, String>()
        try {
            val jobs = JSONArray(handle.listCronJobs())
            for (i in 0 until jobs.length()) {
                val job = jobs.optJSONObject(i) ?: continue
                val id = job.optString("id", "")
                val name = normalized(job.optString("name", ""))
                if (id.isNotEmpty() && name.isNotEmpty()) names[id] = name
            }
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
        }
        return names
    }

    /** `org.json` turns a JSON null into the string "null" in some APIs. */
    private fun normalized(value: String): String = if (value == "null") "" else value

    /** The engine writes booleans into SQLite as 0/1, so accept both shapes. */
    private fun boolField(json: JSONObject, key: String): Boolean? = when (val value = json.opt(key)) {
        null -> null
        is Boolean -> value
        is Number -> value.toInt() != 0
        is String -> value == "1" || value.equals("true", ignoreCase = true)
        else -> null
    }
}
