use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}};

pub(super) struct RunOutput {
    pub cancelled: AtomicBool,
    pub target: Option<isize>,
    #[cfg(windows)]
    pub clipboard: Arc<Mutex<super::clipboard_history::RecordingClipboard>>,
}

pub(super) static RUNS: LazyLock<Mutex<HashMap<String, Arc<RunOutput>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn context(id: Option<&str>) -> Result<Option<Arc<RunOutput>>, String> {
    let Some(id) = id else { return Ok(None); };
    RUNS.lock().map_err(|error| error.to_string())?.get(id).cloned().map(Some)
        .ok_or_else(|| "Запуск уже завершён или отменён.".into())
}

#[tauri::command]
pub fn begin_scenario_output(run_id: String) -> Result<(), String> {
    #[cfg(windows)]
    let target = {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
        let hwnd = unsafe { GetForegroundWindow() };
        let mut process = 0;
        if !hwnd.is_null() { unsafe { GetWindowThreadProcessId(hwnd, &mut process) }; }
        (!hwnd.is_null() && process != unsafe { windows_sys::Win32::System::Threading::GetCurrentProcessId() })
            .then_some(hwnd as isize)
    };
    #[cfg(not(windows))]
    let target = None;
    let output = RunOutput {
        target, cancelled: AtomicBool::new(false),
        #[cfg(windows)]
        clipboard: Arc::new(Mutex::new(super::clipboard_history::RecordingClipboard::at_start())),
    };
    RUNS.lock().map_err(|error| error.to_string())?.insert(run_id, Arc::new(output));
    Ok(())
}

#[tauri::command]
pub fn cancel_scenario_output(run_id: String) -> Result<(), String> {
    if let Some(run) = RUNS.lock().map_err(|error| error.to_string())?.get(&run_id) {
        run.cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub fn finish_scenario_output(run_id: String) -> Result<(), String> {
    RUNS.lock().map_err(|error| error.to_string())?.remove(&run_id);
    Ok(())
}
