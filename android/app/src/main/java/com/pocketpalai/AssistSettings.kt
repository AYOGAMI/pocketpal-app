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
