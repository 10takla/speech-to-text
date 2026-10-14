package com.tauri.dev

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.TextView
import kotlin.math.abs

/** Moves the native window without turning a drag into a click on a recording control. */
class BubbleDragController(
    private val context: Context,
    private val manager: WindowManager,
    private val layout: WindowManager.LayoutParams,
    private val dismiss: () -> Unit,
) {
    private val preferences = context.getSharedPreferences("speech-bubble-position", Context.MODE_PRIVATE)
    private val density = context.resources.displayMetrics.density
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var originX = 0
    private var originY = 0
    private var eligible = false
    private var dragging = false
    private var target: TextView? = null
    private var compactX = px(preferences.getFloat("x", (screenWidth() - px(62)) / density))

    init {
        layout.gravity = Gravity.TOP or Gravity.LEFT
        layout.x = compactX.coerceIn(0, (screenWidth() - px(50)).coerceAtLeast(0))
        layout.y = px(preferences.getFloat("y", 80f)).coerceIn(0, (screenHeight() - layout.height).coerceAtLeast(0))
    }

    private fun px(value: Int) = px(value.toFloat())
    private fun px(value: Float) = (value * density).toInt()
    private fun screenWidth() = context.resources.displayMetrics.widthPixels
    private fun screenHeight() = context.resources.displayMetrics.heightPixels

    fun setExpanded(expanded: Boolean) {
        layout.width = if (expanded) WindowManager.LayoutParams.MATCH_PARENT else px(50)
        layout.x = if (expanded) 0 else compactX.coerceIn(0, (screenWidth() - layout.width).coerceAtLeast(0))
    }

    fun keepOnScreen() {
        layout.y = layout.y.coerceIn(0, (screenHeight() - layout.height).coerceAtLeast(0))
    }

    fun dispatch(view: View, event: MotionEvent, deliver: (MotionEvent) -> Boolean): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                eligible = (layout.width != WindowManager.LayoutParams.MATCH_PARENT || event.y <= px(42)) && event.pointerCount == 1
                downX = event.rawX
                downY = event.rawY
                originX = layout.x
                originY = layout.y
            }
            MotionEvent.ACTION_MOVE -> if (eligible) {
                if (!dragging && (abs(event.rawX - downX) > slop || abs(event.rawY - downY) > slop)) {
                    dragging = true
                    val cancel = MotionEvent.obtain(event)
                    cancel.action = MotionEvent.ACTION_CANCEL
                    deliver(cancel)
                    cancel.recycle()
                    showTarget()
                }
                if (dragging) {
                    if (layout.width != WindowManager.LayoutParams.MATCH_PARENT) {
                        layout.x = (originX + event.rawX - downX).toInt().coerceIn(0, (screenWidth() - layout.width).coerceAtLeast(0))
                    }
                    layout.y = (originY + event.rawY - downY).toInt().coerceIn(0, (screenHeight() - layout.height).coerceAtLeast(0))
                    manager.updateViewLayout(view, layout)
                    val over = overTarget(event)
                    target?.alpha = if (over) 1f else .75f
                    target?.scaleX = if (over) 1.2f else 1f
                    target?.scaleY = if (over) 1.2f else 1f
                    return true
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                eligible = false
                if (dragging) {
                    dragging = false
                    val remove = event.actionMasked == MotionEvent.ACTION_UP && overTarget(event)
                    clearTarget()
                    if (remove) dismiss()
                    else {
                        if (event.actionMasked == MotionEvent.ACTION_CANCEL) {
                            layout.x = originX
                            layout.y = originY
                        } else {
                            if (layout.width != WindowManager.LayoutParams.MATCH_PARENT) {
                                layout.x = if (layout.x + layout.width / 2 < screenWidth() / 2) px(12)
                                    else (screenWidth() - layout.width - px(12)).coerceAtLeast(0)
                                compactX = layout.x
                            }
                            preferences.edit().putFloat("x", compactX / density).putFloat("y", layout.y / density).apply()
                        }
                        manager.updateViewLayout(view, layout)
                    }
                    return true
                }
            }
        }
        return deliver(event)
    }

    private fun showTarget() {
        if (target != null) return
        target = TextView(context).apply {
            text = "×"
            contentDescription = "Убрать оверлей и отменить запись"
            textSize = 36f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.rgb(185, 28, 28)) }
            alpha = .75f
        }
        manager.addView(target, WindowManager.LayoutParams(
            px(64), px(64), WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            android.graphics.PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL; y = px(24) })
    }

    private fun overTarget(event: MotionEvent): Boolean {
        val view = target ?: return false
        val position = IntArray(2)
        view.getLocationOnScreen(position)
        val margin = px(20)
        return event.rawX >= position[0] - margin && event.rawX <= position[0] + view.width + margin
            && event.rawY >= position[1] - margin && event.rawY <= position[1] + view.height + margin
    }

    fun clearTarget() {
        target?.let { manager.removeView(it) }
        target = null
    }
}
