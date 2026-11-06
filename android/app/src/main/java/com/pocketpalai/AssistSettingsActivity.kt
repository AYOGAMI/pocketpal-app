package com.pocketpal

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

// The assistant's own settings screen (also opened by the gear in Android's default assistant settings).
class AssistSettingsActivity : ReactActivity() {
    override fun getMainComponentName(): String = "PocketPalAssistSettings"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(null)
    }
}
