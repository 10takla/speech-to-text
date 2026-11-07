use tauri::{AppHandle, Manager};

// The start mode lives only in the Windows Run entry, as `--start-in=<mode>`.
// A launch without the argument (or with an unknown value) opens the window.
const ARGUMENT: &str = "--start-in=";
const MODES: [&str; 3] = ["window", "taskbar", "tray"];
#[cfg(windows)]
const RUN_KEY: &str = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "SpeechToText";

fn mode_in(command: &str) -> Option<&'static str> {
    command.split_whitespace()
        .filter_map(|part| part.trim_matches('"').strip_prefix(ARGUMENT))
        .find_map(|value| MODES.into_iter().find(|mode| *mode == value))
}

pub fn restore(app: &AppHandle) -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = mode_in(&args.join(" ")).unwrap_or("window");
    log::info!("Запуск приложения: --start-in={mode}");
    let Some(window) = app.get_webview_window("main") else { return Ok(()) };
    window.set_skip_taskbar(mode == "tray").map_err(|e| e.to_string())?;
    match mode {
        "taskbar" => {
            window.show().map_err(|e| e.to_string())?;
            window.minimize().map_err(|e| e.to_string())?;
        }
        "tray" => window.hide().map_err(|e| e.to_string())?,
        _ => window.show().map_err(|e| e.to_string())?,
    }
    Ok(())
}

#[cfg(windows)]
fn reg() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new("reg.exe");
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

// The command Windows runs at sign-in, or None without an entry.
#[cfg(windows)]
fn run_entry() -> Result<Option<String>, String> {
    let output = reg().args(["query", RUN_KEY, "/v", RUN_VALUE]).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Ok(None); }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines()
        .find_map(|line| line.trim_start().strip_prefix(RUN_VALUE))
        .and_then(|rest| rest.trim_start().strip_prefix("REG_SZ"))
        .map(|command| command.trim().to_string()))
}

// "" when the app does not start with Windows.
#[tauri::command]
pub fn get_start_in() -> Result<String, String> {
    #[cfg(windows)]
    return Ok(run_entry()?.as_deref().and_then(mode_in).unwrap_or("").to_string());
    #[cfg(not(windows))]
    Ok(String::new())
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
pub fn set_start_in(mode: String) -> Result<(), String> {
    if !mode.is_empty() && !MODES.contains(&mode.as_str()) {
        return Err("Некорректный режим запуска".into());
    }
    #[cfg(windows)]
    {
        let mut command = reg();
        if mode.is_empty() {
            if run_entry()?.is_none() { return Ok(()); }
            command.args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
        } else {
            let executable = executable_for_startup()?;
            // canonicalize may produce a Windows extended path; Run expects a normal path.
            let executable = executable.to_string_lossy();
            let executable = executable.strip_prefix(r"\\?\").unwrap_or(&executable);
            command.args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d"])
                .arg(format!("\"{executable}\" {ARGUMENT}{mode}")).arg("/f");
        }
        let output = command.output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            let reason = String::from_utf8_lossy(&output.stderr);
            let reason = reason.trim();
            return Err(if reason.is_empty() {
                format!("Windows завершила изменение автозапуска с кодом {}", output.status)
            } else {
                reason.to_string()
            });
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    Err("Автозапуск поддерживается только в Windows".into())
}

#[cfg(test)]
mod tests {
    use super::mode_in;

    #[test]
    fn reads_the_mode_from_the_run_command() {
        assert_eq!(mode_in(r#""C:\a b\app.exe" --start-in=tray"#), Some("tray"));
        assert_eq!(mode_in("--start-in=taskbar"), Some("taskbar"));
        assert_eq!(mode_in(r#""C:\app.exe""#), None);
        assert_eq!(mode_in("--start-in=abc"), None);
        assert_eq!(mode_in(r#""C:\app.exe" --startup"#), None);
    }
}
