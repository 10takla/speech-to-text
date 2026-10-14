use super::*;

#[tauri::command]
pub async fn paste_text_into_active_window(
    app: AppHandle,
    state: tauri::State<'_, PasteTargetState>,
    text: String,
) -> Result<(), String> {
    let target = {
        let mut target_state = state.0.lock().map_err(|error| error.to_string())?;
        target_state.recording = false;
        target_state.hwnd.take()
    };
    tauri::async_runtime::spawn_blocking(move || paste_text(app, text, target))
        .await
        .map_err(|error| error.to_string())?
}

fn paste_text(app: AppHandle, text: String, target: Option<isize>) -> Result<(), String> {
    #[cfg(windows)]
    super::clipboard_history::write_text_for_paste(&text)?;
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
            GetForegroundWindow, SetForegroundWindow,
        };

        let _ = app;
        let target =
            target.ok_or_else(|| "Не найдено окно, активное при начале записи.".to_string())?;
        let target = target as windows_sys::Win32::Foundation::HWND;
        if unsafe { GetForegroundWindow() } != target && unsafe { SetForegroundWindow(target) } == 0
        {
            return Err("Windows не разрешила вернуть фокус в исходное окно.".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(80));

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
    }

    #[cfg(not(windows))]
    {
        let _ = (app, target);
        Err("Автоматическая вставка поддерживается только в Windows.".into())
    }
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
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn copy_text_to_clipboard(
    app: AppHandle,
    text: String,
    history_level: Option<i64>,
) -> Result<(), String> {
    let history_level = history_level.unwrap_or(-1);
    if history_level > 0 {
        return Err("Уровень в истории должен быть целым числом не больше 0.".into());
    }
    #[cfg(windows)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || {
            super::clipboard_history::copy_at_level(&text, history_level)
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        if history_level != 0 {
            return Err("Выбор уровня в истории буфера обмена поддерживается только в Windows. Выберите уровень 0.".into());
        }
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard()
            .write_text(text)
            .map_err(|error| error.to_string())
    }
}
