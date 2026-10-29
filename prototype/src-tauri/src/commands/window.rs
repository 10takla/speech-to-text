use super::*;
use std::sync::{Mutex, atomic::{AtomicBool, Ordering}};
use tauri::Emitter;

#[derive(Clone, Copy)]
struct OverlayRelativePosition {
    x: f64,
    y: f64,
}

static OVERLAY_RELATIVE_POSITION: Mutex<Option<OverlayRelativePosition>> = Mutex::new(None);
static OVERLAY_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn show_overlay(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;

    app.emit_to("overlay", "show-overlay-content", ()).map_err(|e| e.to_string())?;
    // show() also makes the WebView visible, so it cannot be replaced by a raw
    // ShowWindow. It activates the overlay, though, which steals focus from the
    // field the user is about to dictate into; hand the focus straight back.
    #[cfg(windows)]
    let previous = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() };
    window.show().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, SetForegroundWindow};
        let overlay = window.hwnd().map_err(|e| e.to_string())?.0 as windows_sys::Win32::Foundation::HWND;
        unsafe {
            if !previous.is_null() && previous != overlay && IsWindow(previous) != 0
                && GetForegroundWindow() != previous {
                SetForegroundWindow(previous);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn resize_control_panel_to_content(app: AppHandle, width: f64, height: f64, _keep_center: Option<bool>) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("Некорректный размер панели управления".into());
    }
    let window = app.get_webview_window("main")
        .ok_or_else(|| "Control panel window not found".to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?;
    let (width, height) = if let Some(ref monitor) = monitor {
        let area = monitor.work_area();
        (width.min(area.size.width as f64 / scale), height.min(area.size.height as f64 / scale))
    } else { (width, height) };
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let max_x = (area.position.x + area.size.width as i32 - size.width as i32).max(area.position.x);
        let max_y = (area.position.y + area.size.height as i32 - size.height as i32).max(area.position.y);
        let next = PhysicalPosition::new(position.x.clamp(area.position.x, max_x), position.y.clamp(area.position.y, max_y));
        if next != position { window.set_position(next).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

#[tauri::command]
pub fn resize_overlay_to_content(app: AppHandle, width: f64, height: f64, keep_center: Option<bool>) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("Некорректный размер оверлея".into());
    }
    let window = app.get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?;
    let anchor_center_x = if keep_center.unwrap_or(false) {
        let old_position = window.outer_position().map_err(|e| e.to_string())?;
        let old_size = window.outer_size().map_err(|e| e.to_string())?;
        Some(old_position.x as i64 + old_size.width as i64 / 2)
    } else {
        None
    };
    let (width, height) = if let Some(ref monitor) = monitor {
        let area = monitor.work_area();
        (width.min(area.size.width as f64 / scale), height.min(area.size.height as f64 / scale))
    } else { (width, height) };
    window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let target_x = anchor_center_x
            .map(|center| (center - size.width as i64 / 2) as i32)
            .unwrap_or(position.x);
        let max_x = (area.position.x + area.size.width as i32 - size.width as i32).max(area.position.x);
        let max_y = (area.position.y + area.size.height as i32 - size.height as i32).max(area.position.y);
        let x = target_x.clamp(area.position.x, max_x);
        let next = PhysicalPosition::new(x, position.y.clamp(area.position.y, max_y));
        if next != position { window.set_position(next).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) -> Result<bool, String> {
    #[cfg(windows)]
    super::clipboard_history::end_recording();
    if let Ok(mut target) = app.state::<PasteTargetState>().0.lock() {
        target.recording = false;
        target.hwnd = None;
    }
    if super::overlay_interaction::is_pinned() { return Ok(false); }
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    window.hide().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn open_microphone_settings() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd.exe")
            .args(["/C", "start", "", "ms-settings:privacy-microphone"])
            .spawn()
            .map_err(|error| format!("Не удалось открыть настройки микрофона: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Открытие настроек микрофона поддерживается только в Windows.".to_string())
    }
}

#[tauri::command]
pub fn start_overlay_dragging(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    OVERLAY_DRAG_ACTIVE.store(true, Ordering::Release);
    if let Err(error) = window.start_dragging() {
        OVERLAY_DRAG_ACTIVE.store(false, Ordering::Release);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn remember_overlay_position(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;
    remember_current_overlay_position(&window)?;
    OVERLAY_DRAG_ACTIVE.store(false, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn is_overlay_dragging() -> bool {
    OVERLAY_DRAG_ACTIVE.load(Ordering::Acquire) && primary_mouse_button_down()
}

fn remember_current_overlay_position(window: &tauri::WebviewWindow) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Не удалось определить монитор оверлея".to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let bounds = monitor_bounds(&monitor);
    *OVERLAY_RELATIVE_POSITION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some(relative_position_for_window(position.x, position.y, &size, &bounds));
    Ok(())
}

fn primary_mouse_button_down() -> bool {
    #[cfg(target_os = "windows")]
    unsafe {
        return windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(
            windows_sys::Win32::UI::Input::KeyboardAndMouse::VK_LBUTTON as i32,
        ) < 0;
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
pub fn position_overlay_on_cursor_monitor(app: AppHandle, reset: Option<bool>) -> Result<bool, String> {
    let window = app
        .get_webview_window("overlay")
        .ok_or_else(|| "Overlay window not found".to_string())?;

    if OVERLAY_DRAG_ACTIVE.load(Ordering::Acquire) {
        if primary_mouse_button_down() {
            return Ok(false);
        }
        OVERLAY_DRAG_ACTIVE.store(false, Ordering::Release);
        let _ = remember_current_overlay_position(&window);
    }

    let cursor = cursor_position_on_screen(&window)?;
    let monitors = window
        .available_monitors()
        .map_err(|e| format!("Failed to get available monitors: {e}"))?;
    let target_monitor = monitors
        .into_iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            cursor.x >= position.x as f64
                && cursor.x < (position.x + size.width as i32) as f64
                && cursor.y >= position.y as f64
                && cursor.y < (position.y + size.height as i32) as f64
        })
        .map(Ok)
        .unwrap_or_else(|| get_fallback_monitor(&window))?;

    let visible = window.is_visible().unwrap_or(false);
    let current_monitor = window.current_monitor().map_err(|e| e.to_string())?;
    let win_size: PhysicalSize<u32> = window
        .outer_size()
        .map_err(|e| format!("Failed to get window outer size: {e}"))?;

    let mut anchor_state = OVERLAY_RELATIVE_POSITION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let target_area = monitor_bounds(&target_monitor);

    if reset.unwrap_or(false) {
        *anchor_state = None;
    }

    if reset.unwrap_or(false) || !visible {
        let (x, y) = if let Some(anchor) = *anchor_state {
            position_for_anchor(anchor, &target_area, &win_size)
        } else {
            centered_bottom_position(target_monitor.work_area(), &win_size)
        };
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| format!("Failed to set window position: {e}"))?;
        if anchor_state.is_none() {
            *anchor_state = Some(relative_position_for_window(x, y, &win_size, &target_area));
        }
        return Ok(true);
    }

    let position = window.outer_position().map_err(|e| e.to_string())?;

    if current_monitor
        .as_ref()
        .is_some_and(|current| same_monitor(current, &target_monitor))
    {
        return Ok(false);
    }

    let anchor = anchor_state.unwrap_or_else(|| {
        current_monitor
            .as_ref()
            .map(|monitor| relative_position_for_window(
                position.x,
                position.y,
                &win_size,
                &monitor_bounds(monitor),
            ))
            .unwrap_or_else(|| relative_position_for_window(
                position.x,
                position.y,
                &win_size,
                &target_area,
            ))
    });

    // Always map from the same saved fractions. Never derive them from the rounded
    // position on the monitor we just arrived at, so repeated transitions cannot drift.
    let (x, y) = position_for_anchor(anchor, &target_area, &win_size);
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| format!("Failed to set window position: {e}"))?;

    *anchor_state = Some(anchor);
    Ok(true)
}

fn same_monitor(left: &tauri::Monitor, right: &tauri::Monitor) -> bool {
    left.position() == right.position() && left.size() == right.size()
}

fn relative_position_for_window(
    x: i32,
    y: i32,
    window_size: &PhysicalSize<u32>,
    area: &PhysicalRect<i32, u32>,
) -> OverlayRelativePosition {
    let center_x = x as f64 + window_size.width as f64 / 2.0;
    OverlayRelativePosition {
        x: relative_center(center_x, area.position.x, area.size.width),
        // Resize сохраняет горизонтальный центр и верхний край, а не центр по высоте.
        y: relative_center(y as f64, area.position.y, area.size.height),
    }
}

fn relative_center(center: f64, area_start: i32, area_size: u32) -> f64 {
    if area_size == 0 {
        return 0.5;
    }
    ((center as f64 - area_start as f64) / area_size as f64).clamp(0.0, 1.0)
}

fn monitor_bounds(monitor: &tauri::Monitor) -> PhysicalRect<i32, u32> {
    let area = monitor.work_area();
    PhysicalRect {
        position: area.position,
        size: area.size,
    }
}

fn position_for_anchor(
    anchor: OverlayRelativePosition,
    area: &PhysicalRect<i32, u32>,
    size: &PhysicalSize<u32>,
) -> (i32, i32) {
    let center_x = area.position.x as f64 + area.size.width as f64 * anchor.x;
    let top_y = area.position.y as f64 + area.size.height as f64 * anchor.y;
    let max_x = (area.position.x + area.size.width as i32 - size.width as i32).max(area.position.x);
    let max_y = (area.position.y + area.size.height as i32 - size.height as i32).max(area.position.y);
    (
        ((center_x - size.width as f64 / 2.0).round() as i32).clamp(area.position.x, max_x),
        (top_y.round() as i32).clamp(area.position.y, max_y),
    )
}

fn centered_bottom_position(area: &PhysicalRect<i32, u32>, size: &PhysicalSize<u32>) -> (i32, i32) {
    let max_x = (area.position.x + area.size.width as i32 - size.width as i32).max(area.position.x);
    let max_y = (area.position.y + area.size.height as i32 - size.height as i32).max(area.position.y);
    let x = (area.position.x + (area.size.width as i32 - size.width as i32) / 2)
        .clamp(area.position.x, max_x);
    let y = (area.position.y + area.size.height as i32 - size.height as i32 - 24)
        .clamp(area.position.y, max_y);
    (x, y)
}

fn cursor_position_on_screen(_window: &tauri::WebviewWindow) -> Result<PhysicalPosition<f64>, String> {
    #[cfg(target_os = "windows")]
    {
        let mut point = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        let succeeded = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point)
        };
        if succeeded == 0 {
            return Err("Не удалось получить координаты курсора".into());
        }
        Ok(PhysicalPosition::new(point.x as f64, point.y as f64))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let relative = _window.cursor_position().map_err(|e| e.to_string())?;
        let origin = _window.outer_position().map_err(|e| e.to_string())?;
        Ok(PhysicalPosition::new(
            origin.x as f64 + relative.x,
            origin.y as f64 + relative.y,
        ))
    }
}

fn get_fallback_monitor(window: &tauri::WebviewWindow) -> Result<tauri::Monitor, String> {
    if let Ok(Some(m)) = window.current_monitor() {
        return Ok(m);
    }
    if let Ok(Some(m)) = window.primary_monitor() {
        return Ok(m);
    }
    let monitors = window
        .available_monitors()
        .map_err(|e| format!("Failed to get available monitors: {e}"))?;
    monitors
        .into_iter()
        .next()
        .ok_or_else(|| "No monitor available".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_position_keeps_center_and_top_after_content_resizes() {
        let area = PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(1920, 1040),
        };
        let anchor = relative_position_for_window(700, 80, &PhysicalSize::new(520, 54), &area);
        for (width, height) in [(1100, 400), (120, 54), (840, 200), (260, 80)] {
            let (x, y) = position_for_anchor(anchor, &area, &PhysicalSize::new(width, height));
            assert_eq!(x + width as i32 / 2, 960);
            assert_eq!(y, 80);
        }
    }

    #[test]
    fn overlay_position_fits_smaller_monitor_and_returns_without_anchor_drift() {
        let source = PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(1920, 1040),
        };
        let target = PhysicalRect {
            position: PhysicalPosition::new(-1280, 40),
            size: PhysicalSize::new(1280, 680),
        };
        let size = PhysicalSize::new(520, 200);
        let anchor = relative_position_for_window(1400, 840, &size, &source);
        for _ in 0..20 {
            let (x, y) = position_for_anchor(anchor, &target, &size);
            assert!(x >= -1280 && x + size.width as i32 <= 0);
            assert!(y >= 40 && y + size.height as i32 <= 720);
            assert_eq!(position_for_anchor(anchor, &source, &size), (1400, 840));
        }
    }
}
