use super::*;

#[tauri::command]
pub fn set_record_hotkey(
    app: AppHandle,
    state: tauri::State<'_, RecordHotkeyState>,
    shortcut: String,
) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let parsed = tauri_plugin_global_shortcut::Shortcut::from_str(&shortcut)
        .map_err(|error| format!("Некорректная горячая клавиша: {error}"))?;
    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    if current.as_ref() == Some(&parsed) {
        return Ok(());
    }

    app.global_shortcut().register(parsed).map_err(|error| {
        format!("Не удалось зарегистрировать горячую клавишу {shortcut}: {error}")
    })?;
    if let Some(previous) = current.take() {
        let _ = app.global_shortcut().unregister(previous);
    }
    *current = Some(parsed);
    Ok(())
}

#[tauri::command]
pub fn set_control_hotkeys(
    app: AppHandle,
    state: tauri::State<'_, ControlHotkeyState>,
    pause_shortcut: String,
    cancel_shortcut: String,
) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let pause = tauri_plugin_global_shortcut::Shortcut::from_str(&pause_shortcut)
        .map_err(|error| format!("Некорректная клавиша паузы: {error}"))?;
    let cancel = tauri_plugin_global_shortcut::Shortcut::from_str(&cancel_shortcut)
        .map_err(|error| format!("Некорректная клавиша отмены: {error}"))?;
    if pause == cancel {
        return Err("Клавиши паузы и отмены должны различаться.".into());
    }

    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    let mut registered_now = Vec::new();
    for (next, label) in [
        (&pause, pause_shortcut.as_str()),
        (&cancel, cancel_shortcut.as_str()),
    ] {
        let already_registered = current.0.as_ref() == Some(next) || current.1.as_ref() == Some(next);
        if !already_registered {
            if let Err(error) = app.global_shortcut().register(*next) {
                for shortcut in registered_now {
                    let _ = app.global_shortcut().unregister(shortcut);
                }
                return Err(format!("Не удалось зарегистрировать горячую клавишу {label}: {error}"));
            }
            registered_now.push(*next);
        }
    }

    if let Some(previous) = current.0.take() {
        if previous != pause && previous != cancel {
            let _ = app.global_shortcut().unregister(previous);
        }
    }
    if let Some(previous) = current.1.take() {
        if previous != pause && previous != cancel {
            let _ = app.global_shortcut().unregister(previous);
        }
    }
    *current = (Some(pause), Some(cancel));
    Ok(())
}
