package com.pocketpal

import android.content.Context
import android.os.Bundle
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

// Wakes up the app's engine in the background and runs a JavaScript task (the AI conversation).
object AgentLauncher {
    fun start(ctx: Context, task: String, extras: Bundle) {
        Thread {
            try {
                val app = ctx.applicationContext as ReactApplication
                val host = app.reactHost
                if (host == null) {
                    HelperLog.add(ctx, "No app engine available for $task")
                    return@Thread
                }
                host.start()
                var rcx: ReactContext? = null
                for (i in 0 until 150) {
                    rcx = host.currentReactContext
                    if (rcx != null && rcx.hasActiveReactInstance()) break
                    Thread.sleep(200)
                }
                if (rcx == null) {
                    HelperLog.add(ctx, "The app engine did not start for $task")
                    return@Thread
                }
                Thread.sleep(2000)
                val cfg = HeadlessJsTaskConfig(task, Arguments.fromBundle(extras), 420000, true)
                val target: ReactContext = rcx
                UiThreadUtil.runOnUiThread {
                    try {
                        HeadlessJsTaskContext.getInstance(target).startTask(cfg)
                        HelperLog.add(ctx, "Started $task")
                    } catch (e: Exception) {
                        HelperLog.add(ctx, "Could not start $task: " + e.message)
                    }
                }
            } catch (e: Exception) {
                HelperLog.add(ctx, "Agent error: " + e.message)
            }
        }.start()
    }
}
