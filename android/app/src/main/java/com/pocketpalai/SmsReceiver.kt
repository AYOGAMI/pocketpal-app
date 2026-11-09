package com.pocketpal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Telephony

// Catches the caller's text reply. With the AI conversation on, the AI answers and asks for details.
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
                HelperLog.add(context, "Text received from $addr")
                prefs.edit().putLong("s_$key", System.currentTimeMillis()).apply()
                val who = prefs.getString("n_$key", addr) ?: addr
                val text = body.toString().trim().replace(Regex("\\s+"), " ").take(400)
                if (AssistSettings.bool(context, "smsAgent", true)) {
                    prefs.edit().putLong("p_$key", System.currentTimeMillis()).apply()
                    val b = Bundle()
                    b.putString("number", addr)
                    b.putString("who", who)
                    b.putString("text", text)
                    HelperLog.add(context, "Handing the reply to the AI")
                    AgentLauncher.start(context, "PocketPalSmsAgent", b)
                } else {
                    val line = "Reason from $who: " + text.take(240)
                    if (AssistSettings.bool(context, "callNote", true)) AssistNotes.add(context, line)
                    if (AssistSettings.bool(context, "callNotify", true)) CallNotice.post(context, "Why they called", line)
                    HelperLog.add(context, "Saved the caller's reason to notes")
                    prefs.edit().remove("p_$key").remove("n_$key").apply()
                }
            }
        } catch (e: Exception) {
            HelperLog.add(context, "Text handling problem: " + e.message)
        }
    }
}
