package com.pocketpal

import android.content.Context
import org.json.JSONObject

// Reads the assistant settings saved from the settings screen (with built-in defaults).
object AssistSettings {
    private fun json(ctx: Context): JSONObject = try {
        JSONObject(ctx.getSharedPreferences("assist_prefs", Context.MODE_PRIVATE).getString("json", "{}") ?: "{}")
    } catch (e: Exception) {
        JSONObject()
    }

    fun int(ctx: Context, key: String, def: Int): Int = json(ctx).optInt(key, def)
    fun bool(ctx: Context, key: String, def: Boolean): Boolean = json(ctx).optBoolean(key, def)
    fun str(ctx: Context, key: String, def: String): String = json(ctx).optString(key, def)
}

object AssistNotes {
    fun add(ctx: Context, text: String) {
        val p = ctx.getSharedPreferences("assist_notes", Context.MODE_PRIVATE)
        val old = p.getString("all", "") ?: ""
        val stamp = java.text.SimpleDateFormat("d MMM HH:mm", java.util.Locale.getDefault()).format(java.util.Date())
        p.edit().putString("all", old + stamp + " - " + text.trim() + "\n").apply()
    }
}

// A short diary of what the call helper did, shown in the settings screen.
object HelperLog {
    fun add(ctx: Context, msg: String) {
        try {
            val p = ctx.getSharedPreferences("assist_calls", Context.MODE_PRIVATE)
            val stamp = java.text.SimpleDateFormat("d MMM HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date())
            val old = p.getString("log", "") ?: ""
            val lines = (old + stamp + "  " + msg + "\n").lines().filter { it.isNotBlank() }.takeLast(80)
            p.edit().putString("log", lines.joinToString("\n") + "\n").apply()
        } catch (e: Exception) {
        }
    }

    fun get(ctx: Context): String = ctx.getSharedPreferences("assist_calls", Context.MODE_PRIVATE).getString("log", "") ?: ""

    fun clear(ctx: Context) {
        ctx.getSharedPreferences("assist_calls", Context.MODE_PRIVATE).edit().remove("log").apply()
    }
}
