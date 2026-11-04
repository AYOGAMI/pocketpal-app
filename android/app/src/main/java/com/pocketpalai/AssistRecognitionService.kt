package com.pocketpal

import android.content.Intent
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

// Required by Android for assistant apps. PocketPal does its own listening in the app.
class AssistRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) {
        try { listener?.error(SpeechRecognizer.ERROR_CLIENT) } catch (e: Exception) { }
    }
    override fun onCancel(listener: Callback?) {}
    override fun onStopListening(listener: Callback?) {}
}
