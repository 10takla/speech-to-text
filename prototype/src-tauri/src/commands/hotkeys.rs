use super::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioHotkeyBinding {
    scenario_id: String,
    shortcut: String,
}

#[tauri::command]
pub fn set_scenario_hotkeys(
    app: AppHandle,
    state: tauri::State<'_, ScenarioHotkeyState>,
    legacy: tauri::State<'_, RecordHotkeyState>,
    controls: tauri::State<'_, ControlHotkeyState>,
    bindings: Vec<ScenarioHotkeyBinding>,
) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let mut next = Vec::new();
    for binding in bindings {
        let key = Shortcut::from_str(&binding.shortcut)
            .map_err(|error| format!("Некорректный триггер: {error}"))?;
        if binding.scenario_id.is_empty() || next.iter().any(|(existing, _)| *existing == key) {
            return Err("Триггеры сценариев должны различаться.".into());
        }
        next.push((key, binding.scenario_id));
    }
    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    let mut previous_legacy = legacy.0.lock().map_err(|error| error.to_string())?;
    let control_keys = controls.0.lock().map_err(|error| error.to_string())?;
    if next.iter().any(|(key, _)| control_keys.0.as_ref() == Some(key) || control_keys.1.as_ref() == Some(key)) {
        return Err("Триггер совпадает с клавишей паузы или отмены.".into());
    }
    let mut registered = Vec::new();
    for (key, _) in &next {
        if current.iter().any(|(old, _)| old == key) || previous_legacy.as_ref() == Some(key) { continue; }
        if let Err(error) = app.global_shortcut().register(*key) {
            for added in registered { let _ = app.global_shortcut().unregister(added); }
            return Err(format!("Не удалось зарегистрировать триггер: {error}"));
        }
        registered.push(*key);
    }
    for (key, _) in current.iter() {
        if !next.iter().any(|(new, _)| new == key) { let _ = app.global_shortcut().unregister(*key); }
    }
    if let Some(key) = previous_legacy.take() {
        if !next.iter().any(|(new, _)| *new == key) { let _ = app.global_shortcut().unregister(key); }
    }
    *current = next;
    Ok(())
}

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
    scenarios: tauri::State<'_, ScenarioHotkeyState>,
    pause_shortcut: String,
    cancel_shortcut: String,
) -> Result<(), String> {
    use std::str::FromStr;
    let pause = tauri_plugin_global_shortcut::Shortcut::from_str(&pause_shortcut)
        .map_err(|error| format!("Некорректная клавиша паузы: {error}"))?;
    let cancel = tauri_plugin_global_shortcut::Shortcut::from_str(&cancel_shortcut)
        .map_err(|error| format!("Некорректная клавиша отмены: {error}"))?;
    if pause == cancel {
        return Err("Клавиши паузы и отмены должны различаться.".into());
    }

    let scenario_keys = scenarios.0.lock().map_err(|error| error.to_string())?;
    if scenario_keys.iter().any(|(key, _)| *key == pause || *key == cancel) {
        return Err("Клавиша паузы или отмены совпадает с триггером сценария.".into());
    }

    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    let active = current.2;
    update_control_hotkeys(&app, &mut current, (Some(pause), Some(cancel), active))
}

#[tauri::command]
pub fn set_control_hotkeys_active(
    app: AppHandle,
    state: tauri::State<'_, ControlHotkeyState>,
    active: bool,
) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|error| error.to_string())?;
    let next = (current.0, current.1, active);
    update_control_hotkeys(&app, &mut current, next)
}

type ControlKeys = (Option<tauri_plugin_global_shortcut::Shortcut>, Option<tauri_plugin_global_shortcut::Shortcut>, bool);

fn registered_control_keys(keys: &ControlKeys) -> Vec<tauri_plugin_global_shortcut::Shortcut> {
    if keys.2 { [keys.0, keys.1].into_iter().flatten().collect() } else { Vec::new() }
}

fn update_control_hotkeys(app: &AppHandle, current: &mut ControlKeys, next: ControlKeys) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let previous = registered_control_keys(current);
    let desired = registered_control_keys(&next);
    let mut added = Vec::new();
    for key in desired.iter().filter(|key| !previous.contains(key)) {
        if let Err(error) = app.global_shortcut().register(*key) {
            for registered in added { let _ = app.global_shortcut().unregister(registered); }
            return Err(format!("Не удалось зарегистрировать горячую клавишу: {error}"));
        }
        added.push(*key);
    }
    for key in previous.iter().filter(|key| !desired.contains(key)) {
        app.global_shortcut().unregister(*key).map_err(|error| error.to_string())?;
    }
    *current = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_controls_do_not_capture_keys() {
        let pause = Some("Ctrl+Alt+D".parse().unwrap());
        let cancel = Some("Escape".parse().unwrap());
        assert!(registered_control_keys(&(pause, cancel, false)).is_empty());
        assert_eq!(registered_control_keys(&(pause, cancel, true)), vec![pause.unwrap(), cancel.unwrap()]);
        assert!(registered_control_keys(&(pause, cancel, false)).is_empty());
    }
}
