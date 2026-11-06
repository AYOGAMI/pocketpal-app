package com.pocketpal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

// Catches the caller's text reply and saves the reason in your notes.
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            val msgs = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
            val prefs = context.getSharedPreferences("assist_calls", Context.MODE_PRIVATE)
            val byAddr = LinkedHashMap<String, StringBuilder>()
            for (m in msgs) {
                val a = m.originatingAddress ?: continue
                byAddr.getOrPut(a) { StringBuilder() }.append(m.messageBody ?: "")
            }
            for ((addr, body) in byAddr) {
                val key = addr.filter { it.isDigit() }.takeLast(9)
                val t = prefs.getLong("p_$key", 0L)
                if (t == 0L || System.currentTimeMillis() - t > 3 * 60 * 60 * 1000L) continue
                val who = prefs.getString("n_$key", addr) ?: addr
                val reason = body.toString().trim().replace(Regex("\\s+"), " ").take(240)
                val line = "Reason from $who: $reason"
                if (AssistSettings.bool(context, "callNote", true)) AssistNotes.add(context, line)
                if (AssistSettings.bool(context, "callNotify", true)) CallNotice.post(context, "Why they called", line)
                prefs.edit().remove("p_$key").remove("n_$key").apply()
            }
        } catch (e: Exception) {
        }
    }
}
