package com.pocketpal

import android.content.Context
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.os.Build
import android.view.View

// "Liquid glass": a lens that bends and softly blurs the app behind it, with a glowing rim and a tint.
// Uses the screenshot Android hands the assistant (needs "use screenshot" on). Android 13+ for the real bending,
// older phones or no screenshot get a plain tinted glass shape.
class GlassView(ctx: Context) : View(ctx) {
    var tintColor: Int = Color.argb(48, 124, 92, 255)
    var cornerDp: Float = 28f
    var strengthDp: Float = 14f

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rim = Paint(Paint.ANTI_ALIAS_FLAG)
    private var agsl: Any? = null
    private var agslFailed = false

    init {
        setWillNotDraw(false)
        rim.style = Paint.Style.STROKE
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        val d = resources.displayMetrics.density
        val r = minOf(cornerDp * d, minOf(w, h) / 2f)
        val rect = RectF(0f, 0f, w, h)
        var drawn = false
        val shot = PocketScreen.shot
        if (Build.VERSION.SDK_INT >= 33 && shot != null && !agslFailed) {
            try {
                val loc = IntArray(2)
                getLocationOnScreen(loc)
                val bs = BitmapShader(shot, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
                val m = Matrix()
                m.setTranslate(-loc[0].toFloat(), -loc[1].toFloat())
                bs.setLocalMatrix(m)
                val rs = AgslGlass.shader(agsl, bs, w, h, r, strengthDp * d, tintColor)
                agsl = rs
                paint.shader = rs as Shader
                canvas.drawRoundRect(rect, r, r, paint)
                drawn = true
            } catch (e: Throwable) {
                agslFailed = true
                HelperLog.add(context, "Glass shader not available: " + e.message)
            }
        }
        if (!drawn) {
            paint.shader = null
            paint.color = tintColor
            canvas.drawRoundRect(rect, r, r, paint)
        }
        // glowing rim: bright on the top left, softer on the bottom right
        val sw = maxOf(1.5f * d, 1f)
        rim.strokeWidth = sw
        rim.shader = LinearGradient(
            0f, 0f, w, h,
            intArrayOf(Color.argb(210, 255, 255, 255), Color.argb(40, 255, 255, 255), Color.argb(130, 255, 255, 255)),
            floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP
        )
        val inset = sw / 2f
        canvas.drawRoundRect(RectF(inset, inset, w - inset, h - inset), r - inset, r - inset, rim)
    }
}

// Kept apart so old Android versions never load the Android 13 shader classes.
object AgslGlass {
    private const val SRC = """
uniform shader bg;
uniform float2 size;
uniform float radius;
uniform float strength;
layout(color) uniform half4 tint;

float sdRound(float2 p, float2 b, float r) {
    float2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

half4 main(float2 fc) {
    float2 c = size * 0.5;
    float2 p = fc - c;
    float d = sdRound(p, c, radius);
    if (d > 0.0) { return half4(0.0); }
    float depth = clamp(-d / (radius * 0.9 + 1.0), 0.0, 1.0);
    float bend = pow(1.0 - depth, 2.2);
    float2 dir = normalize(p + float2(0.0001, 0.0001));
    float2 off = -dir * bend * strength;
    half4 col;
    col.r = bg.eval(fc + off * 1.10).r;
    col.g = bg.eval(fc + off).g;
    col.b = bg.eval(fc + off * 0.90).b;
    col.a = 1.0;
    half3 b1 = bg.eval(fc + off + float2(7.0, 0.0)).rgb;
    half3 b2 = bg.eval(fc + off - float2(7.0, 0.0)).rgb;
    half3 b3 = bg.eval(fc + off + float2(0.0, 7.0)).rgb;
    half3 b4 = bg.eval(fc + off - float2(0.0, 7.0)).rgb;
    col.rgb = mix(col.rgb, (col.rgb + b1 + b2 + b3 + b4) / 5.0, 0.6);
    col.rgb = mix(col.rgb, tint.rgb, tint.a);
    float rimGlow = smoothstep(-4.0, 0.0, d);
    col.rgb += half(rimGlow * (0.30 + 0.25 * dot(dir, normalize(float2(-0.6, -0.8)))));
    col.rgb += half(smoothstep(-radius * 0.6, 0.0, d) * 0.05);
    half a = half(clamp(-d, 0.0, 1.5) / 1.5);
    return half4(col.rgb * a, a);
}
"""

    @android.annotation.SuppressLint("NewApi")
    fun shader(cache: Any?, bs: BitmapShader, w: Float, h: Float, radius: Float, strength: Float, tint: Int): Any {
        val rs = (cache as? android.graphics.RuntimeShader) ?: android.graphics.RuntimeShader(SRC)
        rs.setInputShader("bg", bs)
        rs.setFloatUniform("size", w, h)
        rs.setFloatUniform("radius", radius)
        rs.setFloatUniform("strength", strength)
        rs.setColorUniform("tint", tint)
        return rs
    }
}
