package com.tauri.dev

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyboardBubbleVisibilityTest {
    @Test fun keyboardOpenedWithoutAnEditableNodeShowsBubble() {
        val visibility = KeyboardBubbleVisibility()
        assertFalse(visibility.update(keyboardVisible = false))
        assertTrue(visibility.update(keyboardVisible = true))
    }

    @Test fun closingKeyboardHidesBubble() {
        val visibility = KeyboardBubbleVisibility()
        assertTrue(visibility.update(true))
        assertFalse(visibility.update(false))
    }

    @Test fun dismissalLastsUntilKeyboardCloses() {
        val visibility = KeyboardBubbleVisibility()
        visibility.update(true)
        visibility.dismiss()
        repeat(3) { assertFalse(visibility.update(true)) }
        assertFalse(visibility.update(false))
        assertTrue(visibility.update(true))
    }

    @Test fun changingFocusDoesNotUndoDismissal() {
        val visibility = KeyboardBubbleVisibility()
        visibility.update(true)
        visibility.dismiss()
        assertFalse(visibility.update(true, blocked = true))
        assertFalse(visibility.update(true, blocked = false))
    }

    @Test fun anotherRecordingOrOwnSettingsBlockBubbleTemporarily() {
        val visibility = KeyboardBubbleVisibility()
        assertFalse(visibility.update(true, blocked = true))
        assertTrue(visibility.update(true, blocked = false))
    }

    @Test fun closingKeyboardWhileBlockedResetsDismissal() {
        val visibility = KeyboardBubbleVisibility()
        visibility.dismiss()
        visibility.update(false, blocked = true)
        assertTrue(visibility.update(true))
    }
}
