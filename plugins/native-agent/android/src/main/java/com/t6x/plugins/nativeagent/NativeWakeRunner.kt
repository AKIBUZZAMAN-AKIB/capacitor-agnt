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

    /**
     * The handle of the wake currently in flight, if any.
     *
     * [run] blocks its thread inside Rust, so the only way to stop it from
     * outside is to raise the engine's own abort flag. `handleWake` checks that
     * flag between cron jobs, so aborting returns the loop cleanly at the next
     * boundary: the job in flight still finalizes its own `cron_runs` row and
     * everything untouched stays due for the next wake.
     */
    @Volatile
    private var activeHandle: uniffi.native_agent_ffi.NativeAgentHandle? = null

    /**
     * Ask the in-flight wake to stop at the next safe point.
     *
     * Called from [NativeAgentWakeWorker.onStopped]. WorkManager stops a worker
     * when it exceeds its 10-minute ceiling, when its constraints stop being
     * met, or when the work is cancelled — but stopping the worker does NOT
     * stop this blocking Rust call, which carried on running (and writing) on a
     * thread WorkManager had already stopped accounting for.
     *
     * Safe to call when nothing is running, and safe to call twice.
     */
    fun requestCancel() {
        // A fresh handle is built for every wake, so raising the flag here can
        // never leak into the next one.
        runCatching { activeHandle?.abort() }
    }

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
            activeHandle = restored
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
            activeHandle = null
            try {
                handle?.close()
            } catch (t: Throwable) {
                if (t is OutOfMemoryError) throw t
            }
        }
    }
}
