use super::*;

#[tauri::command]
pub async fn paste_text_into_active_window(
    app: AppHandle,
    state: tauri::State<'_, PasteTargetState>,
    text: String,
    return_focus_to_original_window: Option<bool>,
    run_id: Option<String>,
) -> Result<(), String> {
    let context = super::scenario_output::context(run_id.as_deref())?;
    let target = {
        let mut target_state = state.0.lock().map_err(|error| error.to_string())?;
        target_state.recording = false;
        target_state.hwnd
    };
    let target = context.as_ref().map(|run| run.target).unwrap_or(target);
    tauri::async_runtime::spawn_blocking(move || paste_text(app, text, target, return_focus_to_original_window.unwrap_or(false), context))
        .await
        .map_err(|error| error.to_string())?
}

fn select_paste_target(original: Option<isize>, current: Option<isize>, return_focus: bool) -> Result<isize, String> {
    if return_focus {
        original.ok_or_else(|| "Не найдено окно, активное при начале сценария.".to_string())
    } else {
        current.ok_or_else(|| "Не найдено активное окно для вставки.".to_string())
    }
}

fn paste_text(app: AppHandle, text: String, target: Option<isize>, return_focus: bool,
    context: Option<std::sync::Arc<super::scenario_output::RunOutput>>) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard()
            .write_text(text)
            .map_err(|error| error.to_string())?;
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VK_CONTROL,
            VK_V,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId, IsHungAppWindow, IsWindow, SetForegroundWindow,
        };

        let _ = app;
        let current = unsafe { GetForegroundWindow() };
        let target = select_paste_target(target, (!current.is_null()).then_some(current as isize), return_focus)?;
        let target = target as windows_sys::Win32::Foundation::HWND;
        let mut process_id = 0;
        unsafe { GetWindowThreadProcessId(target, &mut process_id) };
        if process_id == unsafe { windows_sys::Win32::System::Threading::GetCurrentProcessId() } {
            return Err("Выберите поле для вставки в другом приложении.".into());
        }
        if unsafe { IsWindow(target) } == 0 {
            return Err("Окно для вставки уже закрыто.".into());
        }
        if unsafe { IsHungAppWindow(target) } != 0 {
            return Err("Окно для вставки не отвечает. Вставка отменена.".into());
        }
        if return_focus && unsafe { GetForegroundWindow() } != target {
            if unsafe { SetForegroundWindow(target) } == 0 {
                return Err("Windows не разрешила вернуть фокус в исходное окно.".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        if unsafe { GetForegroundWindow() } != target {
            return Err("Окно для вставки потеряло фокус. Вставка отменена.".into());
        }
        if is_console_window(target) {
            // Console programs (e.g. Claude Code) read the clipboard on Ctrl+V by
            // themselves and later than any reader we can observe, so restoring the
            // clipboard would make them paste the old content. Type the text instead.
            log::info!("paste: target is a console window, typing {} directly",
                super::clipboard_history::preview(&text));
            return type_text(&text);
        }
        let target_handle = target as isize;
        let readers = window_processes(target);
        super::clipboard_history::with_text_for_paste(&text, context, readers, move || {
            let target = target_handle as windows_sys::Win32::Foundation::HWND;
            if unsafe { GetForegroundWindow() } != target {
                return Err("Окно для вставки потеряло фокус. Вставка отменена.".into());
            }

            let inputs = [
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_CONTROL,
                            wScan: 0,
                            dwFlags: 0,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_V,
                            wScan: 0,
                            dwFlags: 0,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_V,
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VK_CONTROL,
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
            ];
            let sent = unsafe {
                SendInput(
                    inputs.len() as u32,
                    inputs.as_ptr(),
                    std::mem::size_of::<INPUT>() as i32,
                )
            };
            if sent != inputs.len() as u32 {
                return Err("Windows не отправила Ctrl+V в активное поле.".into());
            }
            Ok(())
        })
    }

    #[cfg(not(windows))]
    {
        let _ = (app, target, return_focus, context);
        Err("Автоматическая вставка поддерживается только в Windows.".into())
    }
}
#[cfg(windows)]
pub(super) fn is_console_window(window: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut class = [0u16; 64];
    let count = unsafe { GetClassNameW(window, class.as_mut_ptr(), class.len() as i32) };
    matches!(String::from_utf16_lossy(&class[..count.max(0) as usize]).as_str(),
        "ConsoleWindowClass" | "CASCADIA_HOSTING_WINDOW_CLASS")
}

// Types the text as Unicode key events into the focused window. Line breaks
// become spaces: in a console Enter would submit the line mid-text.
#[cfg(windows)]
fn type_text(text: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, SendInput,
    };
    let flat = text.replace("\r\n", " ").replace(['\r', '\n'], " ");
    let mut inputs = Vec::new();
    for unit in flat.encode_utf16() {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: 0, wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
            });
        }
    }
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    if sent != inputs.len() as u32 {
        return Err("Windows не отправила текст в активное окно.".into());
    }
    Ok(())
}

// Processes whose clipboard read counts as the target's Ctrl+V. A UWP frame
// window belongs to ApplicationFrameHost while its app owns a child window.
#[cfg(windows)]
fn window_processes(window: windows_sys::Win32::Foundation::HWND) -> Vec<u32> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetWindowThreadProcessId};
    unsafe extern "system" fn collect(child: HWND, list: LPARAM) -> windows_sys::core::BOOL {
        let list = unsafe { &mut *(list as *mut Vec<u32>) };
        let mut process = 0;
        unsafe { GetWindowThreadProcessId(child, &mut process) };
        if process != 0 && !list.contains(&process) {
            list.push(process);
        }
        1
    }
    let mut processes = Vec::new();
    unsafe {
        collect(window, &mut processes as *mut Vec<u32> as LPARAM);
        EnumChildWindows(window, Some(collect), &mut processes as *mut Vec<u32> as LPARAM);
    }
    processes
}

#[tauri::command]
pub async fn write_clipboard_text(app: AppHandle, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        for attempt in 0..8 {
            match app.clipboard().write_text(text.clone()) {
                Ok(()) => return Ok(()),
                Err(error) if attempt == 7 => return Err(error.to_string()),
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(40)),
            }
        }
        unreachable!()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::select_paste_target;

    #[test]
    fn paste_uses_the_current_window_by_default() {
        assert_eq!(select_paste_target(Some(10), Some(20), false), Ok(20));
        assert_eq!(select_paste_target(None, Some(20), false), Ok(20));
    }

    #[test]
    fn returning_to_the_original_window_is_opt_in() {
        assert_eq!(select_paste_target(Some(10), Some(20), true), Ok(10));
        assert_eq!(select_paste_target(Some(10), None, true), Ok(10));
    }

    #[test]
    fn missing_target_does_not_silently_switch_to_another_window() {
        assert!(select_paste_target(Some(10), None, false).is_err());
        assert!(select_paste_target(None, Some(20), true).is_err());
    }
}

#[tauri::command]
pub async fn copy_text_to_clipboard(
    app: AppHandle,
    text: String,
    history_level: Option<i64>,
    run_id: Option<String>,
) -> Result<(), String> {
    let context = super::scenario_output::context(run_id.as_deref())?;
    let history_level = history_level.unwrap_or(-1);
    if history_level > 0 {
        return Err("Уровень в истории должен быть целым числом не больше 0.".into());
    }
    #[cfg(windows)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || {
            super::clipboard_history::copy_at_level(&text, history_level, context)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = context;
        if history_level != 0 {
            return Err("Выбор уровня в истории буфера обмена поддерживается только в Windows. Выберите уровень 0.".into());
        }
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard()
            .write_text(text)
            .map_err(|error| error.to_string())
    }
}
