package com.pocketpal

import android.content.Context
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.os.Build
import android.view.View

// "Liquid glass": a lens that bends, magnifies and softly blurs the app behind it, with soft light glints.
// No outline. Uses the screenshot Android hands the assistant (needs "use screenshot" on). Android 13+ for the real
// bending; older phones or no screenshot get a plain tinted, softly shaded glass shape.
class GlassView(ctx: Context) : View(ctx) {
    var tintColor: Int = Color.argb(48, 124, 92, 255)
    var cornerDp: Float = 28f
    var strengthDp: Float = 14f
    var tracking: Boolean = false // redraw every frame (for lenses that move)

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var agsl: Any? = null
    private var agslFailed = false

    init {
        setWillNotDraw(false)
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
            // no screenshot: still look like glass (soft light from the top left, a little shade below)
            paint.shader = null
            paint.color = tintColor
            canvas.drawRoundRect(rect, r, r, paint)
            paint.shader = android.graphics.RadialGradient(
                w * 0.32f, h * 0.28f, maxOf(w, h) * 0.6f,
                intArrayOf(Color.argb(120, 255, 255, 255), Color.argb(0, 255, 255, 255)), null, Shader.TileMode.CLAMP
            )
            canvas.drawRoundRect(rect, r, r, paint)
            paint.shader = android.graphics.LinearGradient(
                0f, h * 0.55f, 0f, h,
                intArrayOf(Color.argb(0, 0, 0, 0), Color.argb(46, 0, 0, 0)), null, Shader.TileMode.CLAMP
            )
            canvas.drawRoundRect(rect, r, r, paint)
            paint.shader = null
        }
        if (tracking && drawn) postInvalidateOnAnimation()
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
    float half_ = min(size.x, size.y) * 0.5;
    float t = clamp(-d / half_, 0.0, 1.0);
    float lens = pow(1.0 - t, 2.4);
    float2 dir = normalize(p + float2(0.0001, 0.0001));
    float2 off = -dir * lens * strength;
    float2 bulge = -p * 0.10 * (1.0 - lens);
    float2 q = fc + off + bulge;
    half4 col;
    col.r = bg.eval(q + dir * lens * 4.0).r;
    col.g = bg.eval(q).g;
    col.b = bg.eval(q - dir * lens * 4.0).b;
    col.a = 1.0;
    half3 s = bg.eval(q + float2(8.0, 0.0)).rgb + bg.eval(q - float2(8.0, 0.0)).rgb
            + bg.eval(q + float2(0.0, 8.0)).rgb + bg.eval(q - float2(0.0, 8.0)).rgb;
    col.rgb = mix(col.rgb, (col.rgb * 2.0 + s) / 6.0, 0.7);
    half luma = dot(col.rgb, half3(0.299, 0.587, 0.114));
    col.rgb = mix(half3(luma), col.rgb, 1.25) + 0.04;
    col.rgb = mix(col.rgb, tint.rgb, tint.a);
    float2 L = normalize(float2(-0.55, -0.83));
    float side = dot(dir, L);
    float band = 1.0 - t;
    float glint1 = pow(max(side, 0.0), 3.0) * band * band * 0.55;
    float glint2 = pow(max(-side, 0.0), 4.0) * band * band * 0.22;
    col.rgb += half(glint1 + glint2);
    col.rgb *= half(1.0 - 0.10 * pow(max(-side, 0.0), 2.0) * band);
    float2 hp = (p / half_) - float2(-0.38, -0.44);
    col.rgb += half(exp(-dot(hp, hp) * 14.0) * 0.26);
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
