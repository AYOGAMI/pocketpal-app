package com.pocketpal

import android.graphics.Bitmap
import android.app.assist.AssistContent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionSession

class AssistSession(ctx: Context) : VoiceInteractionSession(ctx) {
    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        PocketScreen.screenText = ""
        PocketScreen.shot = null
        val intent = Intent(context, AssistLaunchActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startAssistantActivity(intent)
        } catch (e: Exception) {
            try { context.startActivity(intent) } catch (e2: Exception) { }
        }
        hide()
    }

    // Android hands the assistant a screenshot of the app underneath (if "use screenshot" is on).
    override fun onHandleScreenshot(screenshot: Bitmap?) {
        PocketScreen.shot = screenshot
    }

    // Android hands the assistant the text of the app on screen (if "use text from screen" is on).
    @Deprecated("Deprecated in Java")
    override fun onHandleAssist(data: Bundle?, structure: AssistStructure?, content: AssistContent?) {
        try {
            if (structure == null) return
            val sb = StringBuilder()
            for (w in 0 until structure.windowNodeCount) {
                collect(structure.getWindowNodeAt(w).rootViewNode, sb)
                if (sb.length > 8000) break
            }
            PocketScreen.screenText = sb.toString().take(8000)
        } catch (e: Exception) {
        }
    }

    private fun collect(node: AssistStructure.ViewNode, sb: StringBuilder) {
        if (sb.length > 8000) return
        val t = node.text?.toString()
        val d = node.contentDescription?.toString()
        val piece = if (!t.isNullOrBlank()) t else d
        if (!piece.isNullOrBlank() && !sb.endsWith(piece + "\n")) sb.append(piece.trim()).append('\n')
        for (i in 0 until node.childCount) collect(node.getChildAt(i), sb)
    }
}
