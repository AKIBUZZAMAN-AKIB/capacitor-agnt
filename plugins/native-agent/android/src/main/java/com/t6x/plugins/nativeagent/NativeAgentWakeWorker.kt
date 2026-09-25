package com.t6x.plugins.nativeagent

import android.content.Context
import android.util.Log
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * The OS-facing entry point of the agent's background wake.
 *
 * WorkManager instantiates this class by name in a process that may have no
 * Activity, no WebView and no Capacitor bridge — so it must be public (default
 * Kotlin visibility) with the standard `(Context, WorkerParameters)`
 * constructor, and everything it needs must come from disk. That work lives in
 * [NativeWakeRunner]; this class only translates its outcome into a
 * WorkManager `Result`.
 *
 * `Result.success()` is returned even when the wake itself failed, and that is
 * not a swallowed error: WorkManager's own contract is that periodic work
 * "cannot terminate in a succeeded or failed state, since it must recur" — every
 * result transitions back to ENQUEUED — so `Result.failure()` would not stop or
 * retry anything, it would only mislabel the run in `WorkInfo`. What matters is
 * that the failure is *visible*: [NativeWakeRunner] records every outcome in the
 * telemetry `getWakeStatus()` reports, and the next interval retries on its own.
 */
class NativeAgentWakeWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {

    override fun doWork(): Result {
        val outcome = NativeWakeRunner.run(applicationContext, NativeWakeRunner.SOURCE_WORKER)
        if (outcome.ok) {
            Log.i(TAG, "background wake: ${outcome.summary}")
        } else {
            Log.w(TAG, "background wake did not run: ${outcome.summary}")
        }
        return Result.success()
    }

    /**
     * WorkManager is taking the worker away — past the 10-minute ceiling, a
     * constraint no longer met, or the work was cancelled.
     *
     * Stopping the worker does not stop the blocking Rust call underneath, so
     * without this the engine kept running (and writing rows) on a thread the
     * OS had already stopped accounting for. Raising the engine's abort flag
     * makes the wake loop return at its next job boundary instead.
     */
    override fun onStopped() {
        Log.w(TAG, "WorkManager stopped the worker — asking the engine to wind down")
        NativeWakeRunner.requestCancel()
        super.onStopped()
    }

    private companion object {
        const val TAG = "NativeAgentWakeWorker"
    }
}
