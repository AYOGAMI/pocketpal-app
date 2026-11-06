package com.pocketpal

import android.service.notification.NotificationListenerService

// Lets the assistant read your notifications once you turn on "notification access" for PocketPal.
class AssistNotificationService : NotificationListenerService() {
    override fun onListenerConnected() {
        instance = this
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
    }

    companion object {
        @Volatile var instance: AssistNotificationService? = null
    }
}
