package com.pocketpal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

// Starts the call helper again after the phone restarts (if it was on and "keep on" is allowed).
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
            val wasOn = context.getSharedPreferences("assist_calls", Context.MODE_PRIVATE).getBoolean("enabled", false)
            if (wasOn && AssistSettings.bool(context, "callAlways", true)) {
                ContextCompat.startForegroundService(context, Intent(context, CallHelperService::class.java))
                HelperLog.add(context, "Call helper restarted after the phone started")
            }
        } catch (e: Exception) {
            HelperLog.add(context, "Could not restart the call helper: " + e.message)
        }
    }
}
