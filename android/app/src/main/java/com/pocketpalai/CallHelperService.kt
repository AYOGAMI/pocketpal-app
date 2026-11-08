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
import android.os.Bundle
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

// Watches ringing calls. If you ignore one for the chosen time (or the caller gives up), it
// texts the caller and writes who called into your notes, even with the phone locked.
// Android does not let any app answer a call and talk into it, so this is the closest possible.
class CallHelperService : Service() {
    private var tm: TelephonyManager? = null
    private var listener: PhoneStateListener? = null
    private val handler = Handler(Looper.getMainLooper())
    private var declineTask: Runnable? = null
    private var wasRinging = false
    private var answered = false
    private var handledByUs = false
    private var ringStart = 0L
    private var lastNumber = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startFg()
        register()
        running = true
        getSharedPreferences("assist_calls", Context.MODE_PRIVATE).edit().putBoolean("enabled", true).apply()
        HelperLog.add(this, "Call helper started")
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        cancelDecline()
        try { tm?.listen(listener, PhoneStateListener.LISTEN_NONE) } catch (e: Exception) { }
        listener = null
        HelperLog.add(this, "Call helper stopped")
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
            .setContentText("Texts callers you ignore and saves why they called")
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
                onState(state, phoneNumber)
            }
        }
        try {
            tm?.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
            HelperLog.add(this, "Listening for calls")
        } catch (e: Exception) {
            HelperLog.add(this, "Could not listen for calls: " + e.message + " (allow the Phone permission)")
        }
    }

    private fun onState(state: Int, phoneNumber: String?) {
        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> {
                wasRinging = true
                answered = false
                handledByUs = false
                ringStart = System.currentTimeMillis()
                if (!phoneNumber.isNullOrBlank()) lastNumber = phoneNumber
                HelperLog.add(this, "Phone is ringing")
                onRing()
            }
            TelephonyManager.CALL_STATE_OFFHOOK -> {
                answered = true
                cancelDecline()
                HelperLog.add(this, "Call answered or started, the helper stays out of it")
            }
            else -> {
                cancelDecline()
                if (wasRinging && !answered && !handledByUs) {
                    val secs = (System.currentTimeMillis() - ringStart) / 1000
                    HelperLog.add(this, "Caller hung up after $secs seconds")
                    if (AssistSettings.bool(this, "callOnMissed", true) && secs >= 3) {
                        handledByUs = true
                        handler.postDelayed({ afterDecline(false) }, 2500)
                    }
                }
                wasRinging = false
            }
        }
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
        HelperLog.add(this, "Waiting $secs seconds before acting")
    }

    @Suppress("DEPRECATION")
    private fun decline() {
        declineTask = null
        handledByUs = true
        if (AssistSettings.str(this, "callMode", "text") == "answer") {
            HelperLog.add(this, "Starting the AI to answer this call")
            val b = Bundle()
            b.putString("number", lastNumber)
            b.putString("who", if (lastNumber.isNotBlank()) (nameFor(lastNumber).ifBlank { lastNumber }) else "an unknown number")
            AgentLauncher.start(this, "PocketPalCallAgent", b)
            return
        }
        if (AssistSettings.bool(this, "callDecline", true)) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ANSWER_PHONE_CALLS) == PackageManager.PERMISSION_GRANTED) {
                try {
                    val ended = (getSystemService(Context.TELECOM_SERVICE) as TelecomManager).endCall()
                    HelperLog.add(this, if (ended) "Call declined" else "Android refused to end the call")
                } catch (e: Exception) {
                    HelperLog.add(this, "Could not decline: " + e.message)
                }
            } else {
                HelperLog.add(this, "Cannot decline: the Phone calls permission is missing")
            }
        }
        handler.postDelayed({ afterDecline(true) }, 2500)
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

    private fun afterDecline(declined: Boolean) {
        var number = lastNumber
        var name = ""
        try {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED) {
                contentResolver.query(
                    CallLog.Calls.CONTENT_URI,
                    arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME),
                    null, null, CallLog.Calls.DATE + " DESC"
                )?.use { c ->
                    if (c.moveToFirst()) {
                        val n = c.getString(0) ?: ""
                        if (n.isNotBlank()) number = n
                        name = c.getString(1) ?: ""
                    }
                }
            } else {
                HelperLog.add(this, "Cannot read the caller's number: the Call log permission is missing")
            }
        } catch (e: Exception) {
            HelperLog.add(this, "Call log problem: " + e.message)
        }
        if (name.isBlank() && number.isNotBlank()) name = nameFor(number)
        val who = when {
            name.isNotBlank() && number.isNotBlank() -> "$name ($number)"
            number.isNotBlank() -> number
            else -> "an unknown or hidden number"
        }
        HelperLog.add(this, "Caller: $who")
        var texted = false
        if (number.isNotBlank() && AssistSettings.bool(this, "callSms", true)) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED) {
                try {
                    val sms: SmsManager = if (Build.VERSION.SDK_INT >= 31) getSystemService(SmsManager::class.java) else SmsManager.getDefault()
                    val text = AssistSettings.str(this, "callSmsText",
                        "Hi, I'm busy right now. Please text me who you are and what it's about, and I'll get back to you.")
                    val parts = sms.divideMessage(text)
                    sms.sendMultipartTextMessage(number, null, parts, null, null)
                    texted = true
                    HelperLog.add(this, "Text sent to the caller")
                    getSharedPreferences("assist_calls", Context.MODE_PRIVATE).edit()
                        .putLong("p_" + digitsKey(number), System.currentTimeMillis())
                        .putString("n_" + digitsKey(number), who).apply()
                } catch (e: Exception) {
                    HelperLog.add(this, "Could not send the text: " + e.message)
                }
            } else {
                HelperLog.add(this, "Cannot send a text: the SMS permission is missing")
            }
        }
        val line = "Missed call from $who. " + (if (texted) "I texted them and I am waiting for the reason." else "No text was sent.")
        if (AssistSettings.bool(this, "callNote", true)) {
            AssistNotes.add(this, line)
            HelperLog.add(this, "Saved to notes")
        }
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
