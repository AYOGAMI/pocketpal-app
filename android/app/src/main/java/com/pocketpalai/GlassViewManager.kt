package com.pocketpal

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

class GlassViewManager : SimpleViewManager<GlassView>() {
    override fun getName(): String = "PocketGlass"

    override fun createViewInstance(reactContext: ThemedReactContext): GlassView = GlassView(reactContext)

    @ReactProp(name = "tint", customType = "Color")
    fun setTint(view: GlassView, color: Int) {
        view.tintColor = color
        view.invalidate()
    }

    @ReactProp(name = "radius", defaultFloat = 28f)
    fun setRadius(view: GlassView, radius: Float) {
        view.cornerDp = radius
        view.invalidate()
    }

    @ReactProp(name = "strength", defaultFloat = 14f)
    fun setStrength(view: GlassView, strength: Float) {
        view.strengthDp = strength
        view.invalidate()
    }
}
