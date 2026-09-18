package com.t6x.plugins.nativeagent

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.app.job.PeriodicJobRequest
import android.content.Context
import android.os.Build
import java.util.concurrent.TimeUnit

/**
 * Thin wrapper around the framework JobScheduler for the periodic background
 * wake job ([NativeAgentJobService]). No androidx dependency on purpose.
 *
 * Interval floors are enforced by the OS, not by us:
 *  - API 24+: periodic jobs need elapseAfter + flex >= 15 minutes.
 *  - API 23:  periodic jobs need >= 30 minutes.
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
        val builder = PeriodicJobRequest.Builder(JOB_ID, NativeAgentJobService::class.java)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true) // survive reboots (re-registered by the OS)

        val effectiveMinutes: Int
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            effectiveMinutes = maxOf(requestedMinutes, 15)
            val totalMs = effectiveMinutes * 60_000L
            val flexMs = minOf(5 * 60_000L, totalMs / 4)
            builder.setPeriodic(totalMs - flexMs, flexMs)
        } else {
            @Suppress("DEPRECATION")
            effectiveMinutes = maxOf(requestedMinutes, 30)
            @Suppress("DEPRECATION")
            builder.setPeriodic(effectiveMinutes.toLong(), TimeUnit.MINUTES)
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
