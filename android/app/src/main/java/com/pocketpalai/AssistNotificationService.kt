package com.pocketpal

import android.app.Notification
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.util.concurrent.ConcurrentHashMap

// Remembers the "Reply" button of chat notifications so the AI can answer RCS and WhatsApp messages.
object ReplyStore {
    val actions = ConcurrentHashMap<String, Notification.Action>()
}

// Lets the assistant read your notifications once you turn on "notification access" for PocketPal.
class AssistNotificationService : NotificationListenerService() {
    private val handler = Handler(Looper.getMainLooper())
    private val chatApps = setOf(
        "com.google.android.apps.messaging", "com.samsung.android.messaging",
        "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger"
    )

    override fun onListenerConnected() {
        instance = this
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        try {
            handleChat(sbn)
        } catch (e: Exception) {
            HelperLog.add(this, "Chat notification problem: " + e.message)
        }
    }

    private fun handleChat(sbn: StatusBarNotification) {
        if (!chatApps.contains(sbn.packageName)) return
        if (!AssistSettings.bool(this, "smsAgent", true)) return
        val nt = sbn.notification ?: return
        if ((nt.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return
        val ex = nt.extras ?: return
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return
        val text = ex.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: return
        val prefs = getSharedPreferences("assist_calls", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val titleDigits = title.filter { it.isDigit() }.takeLast(9)
        var key: String? = null
        var who = ""
        for ((k, v) in prefs.all) {
            if (!k.startsWith("p_")) continue
            val t = (v as? Long) ?: continue
            if (now - t > 3 * 60 * 60 * 1000L) continue
            val kk = k.substring(2)
            val w = prefs.getString("n_$kk", "") ?: ""
            val byNumber = titleDigits.length >= 7 && titleDigits == kk
            val byName = title.trim().length >= 2 && w.lowercase().contains(title.trim().lowercase())
            if (byNumber || byName) {
                key = kk
                who = w
                break
            }
        }
        val matched = key ?: return
        var action: Notification.Action? = null
        val acts = nt.actions ?: return
        for (a in acts) {
            val ris = a.remoteInputs
            if (ris != null && ris.isNotEmpty()) {
                action = a
                break
            }
        }
        val reply = action ?: return
        ReplyStore.actions[matched] = reply
        // ignore our own sent reply showing up in the notification
        val last = prefs.getString("l_$matched", "") ?: ""
        if (last.isNotBlank() && text.contains(last.take(25))) return
        val stamp = text + "|" + sbn.postTime
        if (prefs.getString("z_$matched", "") == stamp) return
        prefs.edit().putString("z_$matched", stamp).apply()
        handler.postDelayed({
            if (System.currentTimeMillis() - prefs.getLong("s_$matched", 0L) < 20000L) {
                HelperLog.add(this, "That message also came as a text, already handled")
                return@postDelayed
            }
            val number = who.substringAfter("(", "").substringBefore(")").ifBlank { who }
            val b = Bundle()
            b.putString("number", number)
            b.putString("who", who.ifBlank { title })
            b.putString("text", text.take(400))
            b.putString("channel", "chat")
            b.putString("key", matched)
            prefs.edit().putLong("p_$matched", System.currentTimeMillis()).apply()
            HelperLog.add(this, "Chat reply from $title (" + sbn.packageName + "): handing it to the AI")
            AgentLauncher.start(this, "PocketPalSmsAgent", b)
        }, 4000)
    }

    companion object {
        @Volatile var instance: AssistNotificationService? = null
    }
}
