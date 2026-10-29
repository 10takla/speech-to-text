package com.tauri.dev

/** Visibility follows the IME window, not whether an app exposes an editable node. */
internal class KeyboardBubbleVisibility {
    private var dismissed = false

    fun update(keyboardVisible: Boolean, blocked: Boolean = false): Boolean {
        if (!keyboardVisible) dismissed = false
        return keyboardVisible && !blocked && !dismissed
    }

    fun dismiss() { dismissed = true }
}
