package com.pocketpal

import android.graphics.Bitmap

// What the assistant was handed when it was called: the text and a screenshot of the app underneath.
object PocketScreen {
    @Volatile var screenText: String = ""
    @Volatile var shot: Bitmap? = null
}
