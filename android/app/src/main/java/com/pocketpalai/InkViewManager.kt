package com.pocketpal

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

class InkViewManager : SimpleViewManager<InkView>() {
    override fun getName(): String = "PocketInk"

    override fun createViewInstance(reactContext: ThemedReactContext): InkView = InkView(reactContext)
}
