package com.pocketpal

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionSession

class AssistSession(ctx: Context) : VoiceInteractionSession(ctx) {
    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        val intent = Intent(context, AssistLaunchActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startAssistantActivity(intent)
        } catch (e: Exception) {
            try { context.startActivity(intent) } catch (e2: Exception) { }
        }
        hide()
    }
}
