package com.t6x.plugins.nativeagent

import android.app.job.JobParameters
import android.app.job.JobService
import android.util.Log

/**
 * Dependency-free background wake component (framework [JobService]; no
 * androidx.work needed — keeps the plugin lightweight).
 *
 * A periodic job (registered through [NativeAgentSchedule]) re-enters the
 * Rust scheduler through [NativeAgentRegistry.ensureFromSavedConfig] when the
 * WebView is gone, so cron jobs and the heartbeat keep running in the
 * background. The engine itself enforces its own background timeouts
 * (see the `agent.background_timeout` event), and an exceeded JobService
 * budget simply causes the job to be rescheduled by the OS.
 */
class NativeAgentJobService : JobService() {

    override fun onStartJob(params: JobParameters?): Boolean {
        return try {
            val handle = NativeAgentRegistry.ensureFromSavedConfig(applicationContext)
            if (handle != null) {
                handle.handleWake("android_job_service")
            } else {
                Log.w(TAG, "background wake skipped: no saved init config (initialize() never ran?)")
            }
            // Work is delegated to the engine's own runtime; the OS job is done.
            false
        } catch (t: Throwable) {
            // Catch Throwable deliberately: a missing .so for this ABI surfaces
            // as UnsatisfiedLinkError and must not take the app process down.
            Log.w(TAG, "background wake failed: ${t.message}")
            false
        }
    }

    override fun onStopJob(params: JobParameters?): Boolean = false

    companion object {
        private const val TAG = "NativeAgentJob"
    }
}
