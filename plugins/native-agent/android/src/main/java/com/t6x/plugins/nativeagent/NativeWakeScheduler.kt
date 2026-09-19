package com.t6x.plugins.nativeagent

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkInfo
import androidx.work.WorkManager
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Android half of the background-wake feature: a periodic WorkManager job that
 * runs [NativeAgentWakeWorker] even when the app process does not exist.
 *
 * ## Why WorkManager and not JobScheduler / AlarmManager / a foreground service
 *
 *  * **JobScheduler** is what WorkManager already uses underneath, but it hands
 *    you no persistence or status API: `getPendingJob()` returns a `JobInfo`, not
 *    a state, and a job lost to a reboot or an app-standby bucket change is
 *    invisible. WorkManager stores its own database, reschedules after reboot
 *    and answers `getWorkInfosForUniqueWork()` with real state.
 *  * **AlarmManager** would need `SCHEDULE_EXACT_ALARM` (a user-facing special
 *    permission since Android 12, and on Android 14+ Play restricts exact alarms
 *    to alarm-clock apps — this is an agent scheduler, not an alarm clock), and
 *    exact delivery buys nothing for "evaluate due work eventually".
 *  * **Foreground service** would show a permanent notification, needs
 *    `FOREGROUND_SERVICE_*` types and cannot even be started from the background
 *    on Android 12+.
 *
 * ## The honest limits (reported, never hidden)
 *
 *  * WorkManager refuses periodic intervals below
 *    `PeriodicWorkRequest.MIN_PERIODIC_INTERVAL_MILLIS` (15 min), so a smaller
 *    request is floored and the granted interval is returned to the caller.
 *  * The interval is a *minimum*: Doze, App Standby buckets and the constraints
 *    below can delay or skip a run. That is why every wake records what it did.
 *  * With `ExistingPeriodicWorkPolicy.UPDATE`, re-scheduling an armed wake
 *    updates the spec but keeps the original enqueue time, i.e. a new interval
 *    takes effect from the next cycle rather than resetting the clock.
 */
internal object NativeWakeScheduler {

    /** Unique work name; there is exactly one agent wake in the queue. */
    const val UNIQUE_WORK_NAME = "native-agent-wake"

    private const val TAG = "NativeWakeScheduler"

    data class Status(
        val jobScheduled: Boolean,
        val intervalMinutes: Int,
        val nextRunApproxMs: Long?,
        val state: String?,
        val runAttemptCount: Int,
        val requiresCharging: Boolean,
        val reason: String? = null,
    )

    /**
     * Arms (or re-arms) the periodic wake. Never throws: a refused job comes back
     * as `jobScheduled = false` with the reason, so the JS layer always receives
     * the same envelope.
     */
    fun schedule(context: Context, requestedMinutes: Int, requiresCharging: Boolean): Status {
        val appContext = context.applicationContext
        val store = NativeWakeStore(appContext)
        val minutes = maxOf(requestedMinutes, NativeWakeStore.MIN_INTERVAL_MINUTES)
        return try {
            val constraints = Constraints.Builder()
                // A wake without a network can only fail the LLM call, so the job
                // waits for connectivity instead of burning a run on it.
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .apply { if (requiresCharging) setRequiresCharging(true) }
                .build()

            val request = PeriodicWorkRequest.Builder(
                NativeAgentWakeWorker::class.java,
                minutes.toLong(),
                TimeUnit.MINUTES,
            )
                // Only the first run is delayed by this (documented WorkManager
                // behaviour): the user gets a full interval before the first
                // background run, not one immediately after install.
                .setInitialDelay(minutes.toLong(), TimeUnit.MINUTES)
                .setConstraints(constraints)
                .addTag(UNIQUE_WORK_NAME)
                .build()

            WorkManager.getInstance(appContext)
                .enqueueUniquePeriodicWork(UNIQUE_WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)

            store.intervalMinutes = minutes
            store.requiresCharging = requiresCharging
            status(appContext, minutes, requiresCharging)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            Log.w(TAG, "could not arm the periodic wake: ${t.message}", t)
            Status(false, minutes, null, null, 0, requiresCharging, t.message ?: "WorkManager refused the request")
        }
    }

    /**
     * Cancels the pending wake. Returns the status after cancellation.
     *
     * Cancelling a work name that has nothing enqueued is a no-op, so the reported
     * outcome is a post-condition — *after this call no agent wake is queued* — and
     * not a claim that a job was actually there to remove.
     */
    fun cancel(context: Context): Status {
        val appContext = context.applicationContext
        val store = NativeWakeStore(appContext)
        return try {
            WorkManager.getInstance(appContext).cancelUniqueWork(UNIQUE_WORK_NAME)
            Status(false, 0, null, "CANCELLED", 0, store.requiresCharging)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            Log.w(TAG, "could not cancel the wake: ${t.message}", t)
            Status(false, 0, null, null, 0, store.requiresCharging, t.message ?: "WorkManager refused the cancellation")
        }
    }

    /**
     * Reads the real state out of WorkManager. Blocking (the WorkManager API is
     * future-based), so callers run it off the main thread — the plugin does it
     * inside its IO scope.
     */
    fun status(
        context: Context,
        intervalMinutes: Int = NativeWakeStore(context).intervalMinutes,
        requiresCharging: Boolean = NativeWakeStore(context).requiresCharging,
    ): Status {
        val appContext = context.applicationContext
        return try {
            val infos = WorkManager.getInstance(appContext)
                .getWorkInfosForUniqueWork(UNIQUE_WORK_NAME)
                .get()
            val info = infos.firstOrNull()
            if (info == null) {
                Status(false, intervalMinutes, null, null, 0, requiresCharging)
            } else {
                val stateName = info.state.name
                val next = if (info.state == WorkInfo.State.ENQUEUED) {
                    val raw = info.nextScheduleTimeMillis
                    if (raw in 1 until Long.MAX_VALUE) raw else null
                } else {
                    // RUNNING/SUCCEEDED/FAILED/CANCELLED: the field is defined for
                    // ENQUEUED only, so reporting a number here would be a guess.
                    null
                }
                Status(
                    jobScheduled = info.state == WorkInfo.State.ENQUEUED || info.state == WorkInfo.State.RUNNING,
                    intervalMinutes = intervalMinutes,
                    nextRunApproxMs = next,
                    state = stateName,
                    runAttemptCount = info.runAttemptCount,
                    requiresCharging = requiresCharging,
                )
            }
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            Log.w(TAG, "could not read the wake status: ${t.message}", t)
            Status(false, intervalMinutes, null, null, 0, requiresCharging, t.message ?: "WorkManager is not available")
        }
    }

    /**
     * Due/armed cron jobs the engine knows about, straight from `listCronJobs()`.
     * `pendingTasks` keeps the meaning the previous generation's
     * `getWakeStatus()` gave it: work that is still waiting to run.
     */
    fun cronSummary(jobsJson: String): Pair<Int, Int> {
        var enabled = 0
        var due = 0
        val now = System.currentTimeMillis()
        try {
            val jobs = org.json.JSONArray(jobsJson)
            for (i in 0 until jobs.length()) {
                val job = jobs.optJSONObject(i) ?: continue
                if (!job.optBoolean("enabled", false)) continue
                enabled++
                val nextRunAt = job.optLong("nextRunAt", 0L)
                if (nextRunAt in 1..now) due++
            }
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
        }
        return Pair(enabled, due)
    }

    /** Small helper so callers can echo the raw engine config without crashing. */
    fun schedulerEnabled(schedulerJson: String?): Boolean? {
        if (schedulerJson.isNullOrBlank()) return null
        return try {
            JSONObject(schedulerJson).optBoolean("enabled", true)
        } catch (t: Throwable) {
            if (t is OutOfMemoryError) throw t
            null
        }
    }
}
