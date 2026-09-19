package com.t6x.plugins.phonebuddy

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.util.Log

/**
 * Real OS-level background wakes.
 *
 * The engine cannot wake itself: `phone_buddy`'s scheduler tool only persists
 * tasks (`scheduler.json`) and fires a `scheduler_registered` host event, with
 * the explicit expectation that the host arms its platform scheduler
 * (Android: JobScheduler / WorkManager; iOS: BGTaskScheduler). This class is that
 * host half.
 *
 * API notes (each one mirrors a bug the older agent generation shipped):
 *  * periodic jobs are built with `JobInfo.Builder(JOB_ID, ComponentName)`
 *    + `setPeriodic(...)`; `PeriodicJobRequest` does not exist in the SDK;
 *  * `setPersisted(true)` is NOT used: it throws unless the app declares
 *    RECEIVE_BOOT_COMPLETED, and a JobService survives reboots on its own when
 *    the app is launched again — declaring a broadcast permission we do not
 *    handle would be misleading;
 *  * Android floors periodic intervals at 15 minutes, so the granted interval is
 *    reported back to JS instead of silently ignoring the requested one.
 */
internal object PhoneBuddySchedule {

    const val JOB_ID = 4871
    private const val TAG = "PhoneBuddySchedule"

    fun schedulePeriodicWakes(context: Context, requestedMinutes: Int): Result {
        val minutes = maxOf(requestedMinutes, PhoneBuddyStore.MIN_INTERVAL_MINUTES)
        val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        val service = ComponentName(context, PhoneBuddyWakeService::class.java)

        val job = JobInfo.Builder(JOB_ID, service)
            .setPeriodic(minutes * 60_000L)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setRequiresBatteryNotLow(true)
            .build()

        val status = scheduler.schedule(job)
        if (status != JobScheduler.RESULT_SUCCESS) {
            Log.w(TAG, "JobScheduler refused the periodic wake job (status=$status)")
            return Result(false, minutes, null, "JobScheduler rejected the job (status $status)")
        }
        return Result(true, minutes, scheduler.getPendingJob(JOB_ID)?.let { System.currentTimeMillis() + minutes * 60_000L }, null)
    }

    fun cancelWakes(context: Context): Boolean {
        val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        val had = scheduler.getPendingJob(JOB_ID) != null
        scheduler.cancel(JOB_ID)
        return had
    }

    fun isArmed(context: Context): Boolean {
        val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
        return scheduler.getPendingJob(JOB_ID) != null
    }

    data class Result(
        val jobScheduled: Boolean,
        val intervalMinutes: Int,
        val nextRunApproxMs: Long?,
        val reason: String?,
    )
}
