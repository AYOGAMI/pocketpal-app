package com.pocketpal

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import android.view.MotionEvent
import android.view.View
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ThemedReactContext

// Draw anywhere on the screen: a smooth glowing line follows your finger. When you lift off,
// the area you circled is sent to the assistant (circle to search). A short tap just closes it.
class InkView(private val rctx: ThemedReactContext) : View(rctx) {
    private val path = Path()
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG)
    private val mid = Paint(Paint.ANTI_ALIAS_FLAG)
    private val core = Paint(Paint.ANTI_ALIAS_FLAG)
    private var lx = 0f
    private var ly = 0f
    private var minX = 0f
    private var maxX = 0f
    private var minY = 0f
    private var maxY = 0f
    private var travelled = 0f
    private var fade: ValueAnimator? = null
    private val dp = resources.displayMetrics.density

    init {
        setWillNotDraw(false)
        for (p in listOf(glow, mid, core)) {
            p.style = Paint.Style.STROKE
            p.strokeCap = Paint.Cap.ROUND
            p.strokeJoin = Paint.Join.ROUND
        }
        glow.strokeWidth = 24f * dp
        glow.color = Color.argb(34, 160, 140, 255)
        mid.strokeWidth = 12f * dp
        mid.color = Color.argb(80, 190, 170, 255)
        core.strokeWidth = 5f * dp
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                fade?.cancel()
                alpha = 1f
                path.reset()
                path.moveTo(e.x, e.y)
                lx = e.x
                ly = e.y
                minX = e.x; maxX = e.x; minY = e.y; maxY = e.y
                travelled = 0f
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until e.historySize) add(e.getHistoricalX(i), e.getHistoricalY(i))
                add(e.x, e.y)
                invalidate()
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                path.lineTo(lx, ly)
                invalidate()
                finishStroke()
                return true
            }
        }
        return true
    }

    private fun add(x: Float, y: Float) {
        // smooth curve through the midpoints, so the line has no corners or gaps
        path.quadTo(lx, ly, (x + lx) / 2f, (y + ly) / 2f)
        travelled += Math.hypot((x - lx).toDouble(), (y - ly).toDouble()).toFloat()
        lx = x
        ly = y
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
    }

    private fun finishStroke() {
        try {
            val loc = IntArray(2)
            getLocationOnScreen(loc)
            val shot = PocketScreen.shot
            val sw = (shot?.width ?: resources.displayMetrics.widthPixels).toFloat()
            val sh = (shot?.height ?: resources.displayMetrics.heightPixels).toFloat()
            val pad = 22f * dp
            val x0 = maxOf(0f, minX - pad) + loc[0]
            val y0 = maxOf(0f, minY - pad) + loc[1]
            val x1 = minOf(width.toFloat(), maxX + pad) + loc[0]
            val y1 = minOf(height.toFloat(), maxY + pad) + loc[1]
            val m = Arguments.createMap()
            m.putDouble("moved", (travelled / dp).toDouble())
            m.putDouble("fx", (x0 / sw).toDouble())
            m.putDouble("fy", (y0 / sh).toDouble())
            m.putDouble("fw", ((x1 - x0) / sw).toDouble())
            m.putDouble("fh", ((y1 - y0) / sh).toDouble())
            rctx.reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("AssistInk", m)
        } catch (e: Exception) {
            HelperLog.add(context, "Ink event failed: " + e.message)
        }
        fade?.cancel()
        val a = ValueAnimator.ofFloat(1f, 0f)
        a.duration = 650
        a.startDelay = 250
        a.addUpdateListener { alpha = it.animatedValue as Float }
        a.start()
        fade = a
    }

    override fun onDraw(canvas: Canvas) {
        if (path.isEmpty) return
        val w = maxOf(maxX - minX, 1f)
        core.shader = LinearGradient(
            minX, minY, minX + w, maxY,
            intArrayOf(Color.rgb(142, 197, 255), Color.rgb(201, 167, 255), Color.rgb(255, 158, 216), Color.rgb(255, 213, 158)),
            null, Shader.TileMode.CLAMP
        )
        canvas.drawPath(path, glow)
        canvas.drawPath(path, mid)
        canvas.drawPath(path, core)
    }
}
