use std::sync::Mutex;

const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
static LOGS: Mutex<String> = Mutex::new(String::new());

#[cfg(desktop)]
pub fn dev_logs_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must be inside prototype")
        .join("logs")
}

pub fn target() -> tauri_plugin_log::Target {
    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Dispatch(
        fern::Dispatch::new().chain(fern::Output::call(|record| {
            if let Ok(mut logs) = LOGS.lock() {
                let message = format!("{}\n", record.args());
                logs.push_str(&message);
                if logs.len() > MAX_LOG_BYTES {
                    let mut cut = logs.len() - MAX_LOG_BYTES;
                    while !logs.is_char_boundary(cut) { cut += 1; }
                    logs.drain(..cut);
                }
            }
        })),
    ))
}

#[cfg(desktop)]
pub fn read() -> Result<String, String> {
    LOGS.lock().map(|logs| logs.clone()).map_err(|error| error.to_string())
}
