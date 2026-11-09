package com.pocketpal

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

// Transparent screen that floats the assistant panel over whatever app you were using.
class AssistActivity : ReactActivity() {
    override fun getMainComponentName(): String = "PocketPalAssist"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(null)
        try {
            // frosted-glass look: the app behind the panel is softly blurred (Android 12 and newer)
            if (Build.VERSION.SDK_INT >= 31 && AssistSettings.bool(this, "glass", true)) {
                val radius = AssistSettings.int(this, "glassBlur", 25)
                if (radius > 0) {
                    window.setBackgroundBlurRadius(radius)
                    window.setBackgroundDrawable(ColorDrawable(Color.argb(28, 20, 22, 40)))
                }
            }
        } catch (e: Exception) {
        }
    }
}
