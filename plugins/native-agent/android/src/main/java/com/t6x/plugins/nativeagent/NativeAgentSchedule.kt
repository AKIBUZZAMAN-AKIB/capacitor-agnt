package com.t6x.plugins.nativeagent

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.os.Build

/**
 * Thin wrapper around the framework JobScheduler for the periodic background
 * wake job ([NativeAgentJobService]). No androidx dependency on purpose.
 *
 * Interval floors are enforced by the OS, not by us:
 *  - API 24+: periodic jobs are clamped to >= 15 minutes.
 *  - API 23:  periodic jobs are clamped to >= 30 minutes (no flex support).
 */
object NativeAgentSchedule {

    const val JOB_ID = 0x5a7e

    /**
     * Best-effort in-process flag (JobScheduler queries for job existence are
     * API-version dependent; cancel() itself is always safe to call).
     */
    @Volatile
    private var hasScheduled = false

    data class ScheduleResult(val effectiveIntervalMinutes: Int)

    @JvmStatic
    fun schedulePeriodicWakes(context: Context, requestedMinutes: Int): ScheduleResult {
        val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        val service = ComponentName(context, NativeAgentJobService::class.java)
        val builder = JobInfo.Builder(JOB_ID, service)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)

        val effectiveMinutes: Int
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            // API 24+ accepts an explicit flex window; the OS still clamps the
            // period to JobInfo.getMinPeriodMillis() (15 min).
            effectiveMinutes = maxOf(requestedMinutes, 15)
            val totalMs = effectiveMinutes * 60_000L
            val flexMs = minOf(5 * 60_000L, totalMs / 4)
            builder.setPeriodic(totalMs, flexMs)
        } else {
            effectiveMinutes = maxOf(requestedMinutes, 30)
            builder.setPeriodic(effectiveMinutes * 60_000L)
        }

        scheduler.schedule(builder.build())
        hasScheduled = true
        return ScheduleResult(effectiveMinutes)
    }

    /** Cancels the periodic job (no-op when nothing was scheduled). */
    @JvmStatic
    fun cancelWakes(context: Context): Boolean {
        val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        scheduler.cancel(JOB_ID)
        val had = hasScheduled
        hasScheduled = false
        return had
    }
}
