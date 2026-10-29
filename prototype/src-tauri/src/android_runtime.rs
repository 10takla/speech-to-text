use base64::Engine;
use tauri::{Manager, plugin::{Builder, PluginHandle}};

#[tauri::command]
fn android_runtime_call(
    handle: tauri::State<'_, PluginHandle<tauri::Wry>>,
    action: String,
    payload: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    handle.run_mobile_plugin("call", serde_json::json!({ "action": action, "payload": payload.unwrap_or(serde_json::json!({})) }))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn write_clipboard_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|error| error.to_string())
}

#[tauri::command]
fn copy_text_to_clipboard(app: tauri::AppHandle, text: String, _history_level: Option<i64>) -> Result<(), String> {
    write_clipboard_text(app, text)
}

#[tauri::command]
fn paste_text_into_active_window(app: tauri::AppHandle, handle: tauri::State<'_, PluginHandle<tauri::Wry>>, text: String) -> Result<(), String> {
    write_clipboard_text(app, text.clone())?;
    handle.run_mobile_plugin::<serde_json::Value>("call", serde_json::json!({"action":"paste","payload":{"text":text}}))
        .map(|_| ()).map_err(|error| error.to_string())
}

#[tauri::command]
fn decode_android_audio(data: String) -> Result<tauri::ipc::Response, String> {
    base64::engine::general_purpose::STANDARD.decode(data)
        .map(tauri::ipc::Response::new).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(if cfg!(debug_assertions) {
            tauri_plugin_log::Builder::default().build()
        } else {
            tauri_plugin_log::Builder::default().targets([
                crate::runtime_logs::target(),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
            ]).build()
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(Builder::<tauri::Wry, ()>::new("android-runtime")
            .setup(|app, api| {
                let handle = api.register_android_plugin("com.tauri.dev", "RuntimePlugin")?;
                app.manage(handle);
                Ok(())
            }).build())
        .invoke_handler(tauri::generate_handler![android_runtime_call, write_clipboard_text, copy_text_to_clipboard, paste_text_into_active_window, decode_android_audio])
        .run(tauri::generate_context!())
        .expect("error while running Android application");
}
