package com.tauri.dev

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.webkit.*
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader
import com.speechtotext.app.BuildConfig
import org.json.JSONObject

/** An independent host for the shared recording UI; the user's keyboard stays selected. */
class SpeechBubbleService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    // Keep the existing preference store so upgrades preserve the user's configuration.
    private val preferences by lazy { getSharedPreferences("speech-keyboard", Context.MODE_PRIVATE) }
    private val windowsManager by lazy { getSystemService(WindowManager::class.java) }
    private var browser: WebView? = null
    private var attached = false
    private var active = false
    private var ownsRecording = false
    private var field: AccessibilityNodeInfo? = null
    private var pendingStart: Pair<String, JSONObject>? = null
    private var dismissedField: AccessibilityNodeInfo? = null
    private val layout by lazy {
        WindowManager.LayoutParams(
            dp(50), dp(50),
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            android.graphics.PixelFormat.TRANSLUCENT
        ).apply { gravity = Gravity.TOP or Gravity.END; x = dp(12); y = dp(80) }
    }
    private val dragController by lazy { BubbleDragController(this, windowsManager, layout) { dismissBubble() } }

    override fun onServiceConnected() { RuntimeBridge.bubble = this }
    fun isRecordingOwner() = ownsRecording

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (!isKeyboardVisible()) {
            hide()
            return
        }
        if (event.packageName?.toString() == packageName) return
        val focused = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        val target = focused ?: event.source?.takeIf { it.isFocused }
        if (target?.isEditable == true) {
            field = target
            if (target != dismissedField && (!RuntimeBridge.recorder.isRunning() || ownsRecording)) show()
        } else if (!active && pendingStart == null) {
            field = null
            dismissedField = null
            hide()
        }
    }

    private fun isKeyboardVisible() = windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }

    private fun show() {
        if (!isKeyboardVisible()) return
        if (browser == null) browser = createBrowser()
        if (!attached) {
            windowsManager.addView(browser, layout)
            attached = true
            browser?.onResume()
        }
    }

    private fun hide() {
        dragController.clearTarget()
        if (attached) { windowsManager.removeView(browser); attached = false }
    }

    private fun dismissBubble() {
        dismissedField = field
        evaluate("window.dispatchEvent(new CustomEvent('android-runtime-event',{detail:{action:'cancel-hotkey',text:''}}))")
        if (ownsRecording) RuntimeBridge.recorder.cancel()
        hide()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun maxHeight() = (resources.displayMetrics.heightPixels / resources.displayMetrics.density * .6f).toInt()
    private fun evaluate(script: String) { handler.post { browser?.evaluateJavascript(script, null) } }

    fun syncConfiguration() {
        evaluate("window.dispatchEvent(new CustomEvent('android-configuration',{detail:${JSONObject.quote(preferences.getString("configuration", "") ?: "")}}))")
    }

    private fun createBrowser(): WebView {
        val savedOrigin = preferences.getString("runtimeOrigin", "") ?: ""
        val devOrigin = if (BuildConfig.DEBUG) BuildConfig.STT_DEV_SERVER_URL.ifBlank { savedOrigin }
            .takeIf { Uri.parse(it).host in listOf("127.0.0.1", "localhost") } else null
        val origin = devOrigin ?: "https://tauri.localhost"
        val allowed = Uri.parse(origin)
        val assets = WebViewAssetLoader.Builder().setDomain("tauri.localhost").setHttpAllowed(true)
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        dragController // Restore the saved native position before attaching the window.
        return object : WebView(this) {
            override fun dispatchTouchEvent(event: MotionEvent): Boolean =
                dragController.dispatch(this, event) { super.dispatchTouchEvent(it) }
        }.apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.textZoom = 100
            addJavascriptInterface(BubbleInterface(), "AndroidBubble")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = assets.shouldInterceptRequest(request.url)
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    return uri.scheme != allowed.scheme || uri.host != allowed.host || uri.port != allowed.port
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    Log.d("SpeechBubble", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                    return true
                }
            }
            if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
            loadUrl("$origin/bubble.html")
        }
    }

    inner class BubbleInterface {
        @JavascriptInterface fun configuration(): String = preferences.getString("configuration", "") ?: ""
        @JavascriptInterface fun maxHeight(): Int = this@SpeechBubbleService.maxHeight()
        @JavascriptInterface fun request(id: String, action: String, json: String) {
            handler.post {
                try {
                    val payload = JSONObject(json)
                    if (action == "start") {
                        check(pendingStart == null) { "Запрос записи уже выполняется." }
                        check(!RuntimeBridge.recorder.isRunning()) { "Запись уже выполняется." }
                        pendingStart = id to payload
                        // Start capture while this permission activity is foreground, including when permission already exists.
                        startActivity(Intent(this@SpeechBubbleService, MicrophonePermissionActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION))
                    } else reply(id, execute(action, payload), null)
                } catch (error: Exception) {
                    if (pendingStart?.first == id) pendingStart = null
                    reply(id, null, error.message ?: "Ошибка оверлея")
                }
            }
        }
    }

    fun completeMicrophonePermission(granted: Boolean) {
        val (id, payload) = pendingStart ?: return
        pendingStart = null
        try {
            check(granted) { "Доступ к микрофону не предоставлен." }
            ContextCompat.startForegroundService(this, Intent(this, RecordingService::class.java))
            RuntimeBridge.recorder.start(this, payload.optString("deviceId"))
            ownsRecording = true
            RuntimeBridge.bubbleEmit = { action, text ->
                evaluate("window.dispatchEvent(new CustomEvent('android-runtime-event',{detail:${JSONObject().put("action", action).put("text", text)}}))")
            }
            reply(id, null, null)
        } catch (error: Exception) { reply(id, null, error.message ?: "Не удалось начать запись.") }
    }

    private fun reply(id: String, value: Any?, error: String?) {
        evaluate("window.bubbleReply?.(${JSONObject.quote(id)},${JSONObject.wrap(value)},${error?.let { JSONObject.quote(it) } ?: "null"})")
    }

    private fun execute(action: String, payload: JSONObject): Any? = when (action) {
        "pause" -> { RuntimeBridge.recorder.paused = true; null }
        "resume" -> { RuntimeBridge.recorder.paused = false; null }
        "snapshot" -> JSONObject().put("data", RuntimeBridge.recorder.snapshot())
        "stop" -> JSONObject().put("data", RuntimeBridge.recorder.stop())
        "cancel" -> { if (ownsRecording) RuntimeBridge.recorder.cancel(); null }
        "level" -> RuntimeBridge.recorder.level
        "recordingStatus" -> JSONObject().put("recording", ownsRecording && RuntimeBridge.recorder.isRunning()).put("paused", RuntimeBridge.recorder.paused)
        "updateState" -> {
            val state = payload.optString("state")
            active = state in listOf("recording", "editing", "transcribing")
            dragController.setExpanded(state != "idle")
            if (attached) windowsManager.updateViewLayout(browser, layout)
            if (ownsRecording) RuntimeBridge.service?.updateState(state, payload.optString("status"))
            null
        }
        "stopRecordingService" -> {
            if (ownsRecording) { stopService(Intent(this, RecordingService::class.java)); RuntimeBridge.bubbleEmit = null }
            ownsRecording = false
            null
        }
        "frontendReady" -> null
        "resizeBubble" -> {
            layout.height = dp(payload.optInt("height", 56).coerceIn(40, maxHeight()))
            dragController.keepOnScreen()
            if (attached) windowsManager.updateViewLayout(browser, layout)
            null
        }
        "saveBubbleConfiguration" -> { preferences.edit().putString("configuration", payload.getString("text")).apply(); null }
        "setOutputText" -> { RuntimeBridge.lastText = payload.getString("text"); null }
        "copy" -> { copyText(payload.getString("text")); null }
        "paste" -> { paste(payload.getString("text")); null }
        "playSound" -> {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 35)
            tone.startTone(if (payload.optString("state") == "error") ToneGenerator.TONE_PROP_NACK else ToneGenerator.TONE_PROP_BEEP, 100)
            handler.postDelayed({ tone.release() }, 200)
            null
        }
        "microphoneSettings" -> { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); null }
        else -> throw IllegalArgumentException("Неизвестная команда оверлея: $action")
    }

    private fun copyText(text: String) {
        RuntimeBridge.lastText = text
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Speech to Text", text))
    }

    fun paste(text: String) {
        copyText(text)
        val target = field ?: throw IllegalStateException("Нет активного поля. Текст сохранён в буфере обмена.")
        check(target.refresh() && target.isEditable && target.isFocused && !target.isPassword) {
            "Поле недоступно для вставки. Текст сохранён в буфере обмена."
        }
        val current = target.text?.toString() ?: ""
        val start = target.textSelectionStart.takeIf { it >= 0 } ?: current.length
        val end = target.textSelectionEnd.takeIf { it >= 0 } ?: start
        val from = minOf(start, end).coerceIn(0, current.length)
        val to = maxOf(start, end).coerceIn(from, current.length)
        val updated = current.replaceRange(from, to, text)
        check(target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated)
        })) { "Поле не приняло текст. Он сохранён в буфере обмена." }
        target.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, from + text.length)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, from + text.length)
        })
    }

    override fun onInterrupt() { if (!active) hide() }
    override fun onDestroy() {
        if (RuntimeBridge.bubble === this) RuntimeBridge.bubble = null
        if (ownsRecording) { RuntimeBridge.bubbleEmit = null; RuntimeBridge.recorder.cancel(); stopService(Intent(this, RecordingService::class.java)) }
        hide()
        browser?.removeJavascriptInterface("AndroidBubble")
        browser?.destroy()
        browser = null
        super.onDestroy()
    }
}
