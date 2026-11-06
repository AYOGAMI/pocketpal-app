package com.pocketpal

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.CallLog
import android.provider.ContactsContract
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

// Watches ringing calls. If you ignore one for the chosen time it declines the call, texts the
// caller, and writes who called into your notes (works with the phone locked).
// Android does not let any app answer a call and talk into it, so this is the closest possible.
class CallHelperService : Service() {
    private var tm: TelephonyManager? = null
    private var listener: PhoneStateListener? = null
    private val handler = Handler(Looper.getMainLooper())
    private var declineTask: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startFg()
        register()
        running = true
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        cancelDecline()
        try { tm?.listen(listener, PhoneStateListener.LISTEN_NONE) } catch (e: Exception) { }
        listener = null
        super.onDestroy()
    }

    private fun startFg() {
        val ch = "assist_call_helper"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(ch, "Call helper", NotificationManager.IMPORTANCE_LOW))
        }
        val n: Notification = NotificationCompat.Builder(this, ch)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle("PocketPal call helper is on")
            .setContentText("Declines calls you ignore and texts the caller")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(7001, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(7001, n)
        }
    }

    @Suppress("DEPRECATION")
    private fun register() {
        if (listener != null) return
        tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        listener = object : PhoneStateListener() {
            @Deprecated("Deprecated in Java")
            override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                if (state == TelephonyManager.CALL_STATE_RINGING) onRing() else cancelDecline()
            }
        }
        try { tm?.listen(listener, PhoneStateListener.LISTEN_CALL_STATE) } catch (e: Exception) { }
    }

    private fun cancelDecline() {
        declineTask?.let { handler.removeCallbacks(it) }
        declineTask = null
    }

    private fun onRing() {
        cancelDecline()
        val secs = AssistSettings.int(this, "callSeconds", 20).coerceIn(5, 120)
        val t = Runnable { decline() }
        declineTask = t
        handler.postDelayed(t, secs * 1000L)
    }

    @Suppress("DEPRECATION")
    private fun decline() {
        declineTask = null
        if (AssistSettings.bool(this, "callDecline", true) &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ANSWER_PHONE_CALLS) == PackageManager.PERMISSION_GRANTED) {
            try {
                (getSystemService(Context.TELECOM_SERVICE) as TelecomManager).endCall()
            } catch (e: Exception) { }
        }
        handler.postDelayed({ afterDecline() }, 2500)
    }

    private fun digitsKey(n: String): String = n.filter { it.isDigit() }.takeLast(9)

    private fun nameFor(number: String): String {
        try {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED) {
                val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
                contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) return c.getString(0) ?: ""
                }
            }
        } catch (e: Exception) { }
        return ""
    }

    private fun afterDecline() {
        var number = ""
        var name = ""
        try {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED) {
                contentResolver.query(
                    CallLog.Calls.CONTENT_URI,
                    arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME),
                    null, null, CallLog.Calls.DATE + " DESC"
                )?.use { c ->
                    if (c.moveToFirst()) {
                        number = c.getString(0) ?: ""
                        name = c.getString(1) ?: ""
                    }
                }
            }
        } catch (e: Exception) { }
        if (name.isBlank() && number.isNotBlank()) name = nameFor(number)
        val who = when {
            name.isNotBlank() && number.isNotBlank() -> "$name ($number)"
            number.isNotBlank() -> number
            else -> "an unknown or hidden number"
        }
        var texted = false
        if (number.isNotBlank() && AssistSettings.bool(this, "callSms", true) &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED) {
            try {
                val sms: SmsManager = if (Build.VERSION.SDK_INT >= 31) getSystemService(SmsManager::class.java) else SmsManager.getDefault()
                val text = AssistSettings.str(this, "callSmsText",
                    "Hi, I'm busy right now. Please text me who you are and what it's about, and I'll get back to you.")
                sms.sendTextMessage(number, null, text, null, null)
                texted = true
                getSharedPreferences("assist_calls", Context.MODE_PRIVATE).edit()
                    .putLong("p_" + digitsKey(number), System.currentTimeMillis())
                    .putString("n_" + digitsKey(number), who).apply()
            } catch (e: Exception) { }
        }
        val line = "Missed call from $who. " + (if (texted) "I texted them and I am waiting for the reason." else "No text was sent.")
        if (AssistSettings.bool(this, "callNote", true)) AssistNotes.add(this, line)
        if (AssistSettings.bool(this, "callNotify", true)) CallNotice.post(this, "Missed call", line)
    }

    companion object {
        @Volatile var running = false
    }
}

object CallNotice {
    fun post(ctx: Context, title: String, text: String) {
        try {
            val ch = "assist_call_notes"
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) {
                nm.createNotificationChannel(NotificationChannel(ch, "Call notes", NotificationManager.IMPORTANCE_DEFAULT))
            }
            val n = NotificationCompat.Builder(ctx, ch)
                .setSmallIcon(android.R.drawable.sym_call_missed)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .build()
            nm.notify((System.currentTimeMillis() % 100000).toInt() + 8000, n)
        } catch (e: Exception) { }
    }
}
