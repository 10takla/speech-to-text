use tauri::{AppHandle, Manager};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StartupSettings {
    startup_mode: String,
}

impl Default for StartupSettings {
    fn default() -> Self {
        Self { startup_mode: String::new() }
    }
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("startup.json"))
}

pub fn restore(app: &AppHandle) -> Result<(), String> {
    let launched_by_autostart = std::env::args_os()
        .any(|arg| arg == std::ffi::OsStr::new("--startup"));
    log::info!("Запуск приложения: autostart={launched_by_autostart}");
    if !launched_by_autostart {
        if let Some(window) = app.get_webview_window("main") {
            window.set_skip_taskbar(false).map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let path = settings_path(app)?;
    let settings = if path.exists() {
        serde_json::from_slice::<StartupSettings>(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else { StartupSettings::default() };
    log::info!("Режим автозапуска: {}", settings.startup_mode);
    if let Some(window) = app.get_webview_window("main") {
        window.set_skip_taskbar(settings.startup_mode == "tray").map_err(|e| e.to_string())?;
        match settings.startup_mode.as_str() {
            "" | "window" => window.show().map_err(|e| e.to_string())?,
            "hidden-taskbar" => {
                window.show().map_err(|e| e.to_string())?;
                window.minimize().map_err(|e| e.to_string())?;
            }
            "tray" => window.hide().map_err(|e| e.to_string())?,
            _ => window.show().map_err(|e| e.to_string())?,
        }
    }
    Ok(())
}

fn executable_for_startup() -> Result<std::path::PathBuf, String> {
    if cfg!(debug_assertions) {
        // A development executable needs Vite and cannot run independently at login.
        let portable = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../output/speech-to-text-portable.exe");
        return portable.canonicalize().map_err(|_| {
            "Для автозапуска сначала соберите Windows-версию приложения.".to_string()
        });
    }
    std::env::current_exe().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_startup_settings(app: AppHandle, settings: StartupSettings) -> Result<(), String> {
    if !["", "window", "hidden-taskbar", "tray"].contains(&settings.startup_mode.as_str()) {
        return Err("Некорректный режим запуска".into());
    }
    let path = settings_path(&app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("reg.exe");
        command.creation_flags(0x08000000);
        let key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        if settings.startup_mode.is_empty() {
            let query = std::process::Command::new("reg.exe").creation_flags(0x08000000)
                .args(["query", key, "/v", "SpeechToText"]).output().map_err(|e| e.to_string())?;
            if query.status.success() {
                command.args(["delete", key, "/v", "SpeechToText", "/f"]);
            } else {
                return persist(&path, &settings);
            }
        } else {
            let executable = executable_for_startup()?;
            // canonicalize may produce a Windows extended path; Run expects a normal path.
            let executable = executable.to_string_lossy();
            let executable = executable.strip_prefix(r"\\?\").unwrap_or(&executable);
            command.args(["add", key, "/v", "SpeechToText", "/t", "REG_SZ", "/d"])
                .arg(format!("\"{executable}\" --startup")).arg("/f");
        }
        let output = command.output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err("Не удалось изменить автозапуск Windows".into()); }
    }
    #[cfg(not(windows))]
    return Err("Автозапуск поддерживается только в Windows".into());
    persist(&path, &settings)
}

fn persist(path: &std::path::Path, settings: &StartupSettings) -> Result<(), String> {
    std::fs::write(path, serde_json::to_vec(settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(())
}
