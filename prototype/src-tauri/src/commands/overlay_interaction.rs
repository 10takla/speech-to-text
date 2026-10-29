use std::sync::atomic::{AtomicBool, Ordering};

static PINNED: AtomicBool = AtomicBool::new(false);

pub(crate) fn is_pinned() -> bool {
    PINNED.load(Ordering::Acquire)
}

#[tauri::command]
pub fn set_overlay_pinned(pinned: bool) {
    PINNED.store(pinned, Ordering::Release);
}

#[cfg(windows)]
mod windows_interaction {
    use super::*;
    use std::sync::{OnceLock, atomic::AtomicIsize, mpsc};
    use tauri::{Emitter, Manager};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::*,
    };

    static OVERLAY_HWND: AtomicIsize = AtomicIsize::new(0);
    static EVENTS: OnceLock<mpsc::Sender<bool>> = OnceLock::new();

    unsafe extern "system" fn mouse_hook(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
        if code >= 0
            && matches!(
                message as u32,
                WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
            )
        {
            let overlay = OVERLAY_HWND.load(Ordering::Acquire) as HWND;
            if !overlay.is_null() && unsafe { IsWindowVisible(overlay) } != 0 {
                let point = unsafe { (*(data as *const MSLLHOOKSTRUCT)).pt };
                let mut target = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
                // Include native context menus owned by the overlay (for Copy).
                let mut inside = false;
                for _ in 0..8 {
                    if target.is_null() {
                        break;
                    }
                    if target == overlay {
                        inside = true;
                        break;
                    }
                    target = unsafe { GetWindow(target, GW_OWNER) };
                }
                if PINNED.swap(inside, Ordering::AcqRel) != inside {
                    if let Some(events) = EVENTS.get() {
                        let _ = events.send(inside);
                    }
                }
            }
        }
        unsafe { CallNextHookEx(std::ptr::null_mut(), code, message, data) }
    }

    pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
        let window = app
            .get_webview_window("overlay")
            .ok_or("Overlay window not found")?;
        OVERLAY_HWND.store(
            window.hwnd().map_err(|error| error.to_string())?.0 as isize,
            Ordering::Release,
        );
        let (sender, receiver) = mpsc::channel();
        if EVENTS.set(sender).is_err() {
            return Ok(());
        }
        let app = app.clone();
        std::thread::Builder::new()
            .name("overlay-click-events".into())
            .spawn(move || {
                for pinned in receiver {
                    let _ = app.emit_to("overlay", "overlay-pin-changed", pinned);
                }
            })
            .map_err(|error| error.to_string())?;
        std::thread::Builder::new()
            .name("overlay-mouse-hook".into())
            .spawn(|| unsafe {
                let hook = SetWindowsHookExW(
                    WH_MOUSE_LL,
                    Some(mouse_hook),
                    GetModuleHandleW(std::ptr::null()),
                    0,
                );
                if hook.is_null() {
                    log::warn!(
                        "Не удалось отслеживать нажатия вне оверлея: {}",
                        std::io::Error::last_os_error()
                    );
                    return;
                }
                let mut message = MSG::default();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                UnhookWindowsHookEx(hook);
            })
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[cfg(windows)]
pub(crate) use windows_interaction::initialize;
