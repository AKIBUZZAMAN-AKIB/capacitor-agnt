package com.t6x.plugins.phonebuddy

import android.app.job.JobParameters
import android.app.job.JobService
import android.util.Log

/**
 * Periodic OS wake for the agent (registered by [PhoneBuddySchedule]).
 *
 * JobScheduler starts this even when the app is not running, so the service does
 * the whole job on a worker thread: rebuild the engine from the persisted
 * config, run the tasks the engine left in `scheduler.json`, surface their
 * results, then let the OS complete the job.
 *
 * Contract details that matter:
 *  * `onStartJob` returns `true` (work continues asynchronously) and MUST end
 *    with exactly one `jobFinished(params, wantsReschedule)`;
 *  * `onStopJob` returns `true` so a job interrupted by OS pressure/conditions is
 *    rescheduled instead of silently disappearing.
 */
class PhoneBuddyWakeService : JobService() {

    private companion object {
        const val TAG = "PhoneBuddyWakeSvc"
    }

    private var worker: Thread? = null

    override fun onStartJob(params: JobParameters?): Boolean {
        if (params == null) return false
        val store = PhoneBuddyStore(applicationContext)
        worker = Thread({
            var reschedule = false
            try {
                val result = PhoneBuddyWakeRunner.run(applicationContext, source = "jobscheduler")
                Log.i(TAG, "wake finished: ${result.summary}")
            } catch (t: Throwable) {
                // Never let a wake kill the process (UnsatisfiedLinkError on an
                // unsupported ABI is an Error, not an Exception).
                Log.w(TAG, "wake crashed: ${t::class.java.simpleName}: ${t.message}", t)
                reschedule = true
            } finally {
                // Keep the periodic job armed even when the app process was
                // started from scratch by the OS.
                store.saveWakeJob(armed = true, intervalMinutes = store.wakeIntervalMinutes())
                jobFinished(params, reschedule)
            }
        }, "phonebuddy-wake")
        worker?.start()
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        worker?.interrupt()
        worker = null
        // Returning true asks JobScheduler to retry later — a stopped wake means
        // the OS took the CPU back, not that the work is done.
        return true
    }
}
