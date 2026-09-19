package com.t6x.plugins.nativeagent

import android.content.Context
import uniffi.native_agent_ffi.createHandleFromPersistedConfig

/**
 * The cold-start wake path: rebuild the engine from the persisted config, run
 * every due cron job, turn the results into surfaced messages, and report.
 *
 * This runs inside [NativeAgentWakeWorker], i.e. in a process the OS may have
 * started with no WebView, no Capacitor bridge and no in-memory handle. The
 * only durable inputs are the config path (`initialize()` wrote it) and the
 * engine's own SQLite file; the only durable outputs are the `cron_runs` rows
 * the engine writes, the OS notifications, the surfaced store and the telemetry
 * `getWakeStatus()` reads.
 *
 * Two deliberate properties:
 *  * **no crash can escape** — the worker runs in the app's main process on a
 *    background thread, so an `UnsatisfiedLinkError` (ABI without
 *    `libnative_agent_ffi.so`) or a bad config file would take the whole app
 *    down. Everything is caught and reported as data.
 *  * **the memory provider is wired here too** — a cron job whose prompt uses
 *    the engine's `memory_*` tools would otherwise answer "Memory provider not
 *    configured" when it fires in the background but work in the foreground.
 */
internal object NativeWakeRunner {

    /** `wake_source` used by OS-initiated wakes; also what `wakeSource` reports. */
    const val SOURCE_WORKER = "android-worker"

    data class RunResult(val ok: Boolean, val ran: Int, val failed: Int, val summary: String)

    fun run(context: Context, source: String): RunResult {
        val appContext = context.applicationContext
        val store = NativeWakeStore(appContext)
        val startedAt = System.currentTimeMillis()

        val configPath = store.engineConfigPath()
        if (configPath == null) {
            val summary = "engine config was not found — call NativeKit.agent.initialize() so a wake has something to restore"
            store.recordWake(source, summary, 0, false)
            return RunResult(false, 0, 0, summary)
        }

        var handle: uniffi.native_agent_ffi.NativeAgentHandle? = null
        return try {
            val restored = createHandleFromPersistedConfig(configPath)
            handle = restored
            NativeWakeCapture.installRecordingNotifier(appContext, restored)
            // Same provider the foreground wires in initialize(); without it the
            // engine's memory tools answer "Memory provider not configured".
            restored.setMemoryProvider(MemoryProviderImpl(appContext))

            restored.handleWake(source)

            val captured = NativeWakeCapture.capture(appContext, restored, source, startedAt)
            store.recordWake(source, captured.summary, captured.ran, true)
            RunResult(true, captured.ran, captured.failed, captured.summary)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            val summary = "wake failed: ${t::class.java.simpleName}: ${t.message ?: "unknown"}"
            store.recordWake(source, summary, 0, false)
            RunResult(false, 0, 0, summary)
        } finally {
            try {
                handle?.close()
            } catch (t: Throwable) {
                if (t is OutOfMemoryError) throw t
            }
        }
    }
}
