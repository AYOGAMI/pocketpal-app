package com.pocketpal

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

// Needed so the call agent can use the microphone during a call, and for taking screenshots.
class AssistAccessibilityService : AccessibilityService() {
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    override fun onServiceConnected() {
        instance = this
        HelperLog.add(this, "Accessibility service is on")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        @Volatile var instance: AssistAccessibilityService? = null
    }
}
