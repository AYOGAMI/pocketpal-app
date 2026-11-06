package com.pocketpal

// Text of the screen that was open when the assistant was called (filled by AssistSession).
object PocketScreen {
    @Volatile var screenText: String = ""
}
