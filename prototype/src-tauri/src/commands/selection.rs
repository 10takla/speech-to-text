// Text selected in any Windows application, for the "Выделенный текст" step.
//
// Two methods, tried in this order:
// 1. UI Automation TextPattern: asks the focused control for its selection. It
//    touches neither the keyboard nor the clipboard, but not every application
//    exposes it.
// 2. A copy command with the clipboard restored afterwards. It works wherever
//    the application can copy at all, which makes it the dependable fallback.

#[tauri::command]
pub async fn get_selected_text(run_id: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        let context = super::scenario_output::context(Some(run_id.as_str()))?;
        return tauri::async_runtime::spawn_blocking(move || platform::selected_text(context))
            .await
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = run_id;
        Err("Текст по выделению доступен в приложении Windows.".into())
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
        SendInput, VK_C, VK_CONTROL, VK_INSERT, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsWindow, SetForegroundWindow};

    use super::super::clipboard::is_console_window;
    use super::super::clipboard_history::{copy_selection, preview};
    use super::super::scenario_output::RunOutput;

    // The hotkey that started the run is usually still held; a copy sent meanwhile
    // would arrive as Ctrl+Shift+C or similar. Wait for the user to let go.
    const MODIFIER_RELEASE_TIMEOUT: Duration = Duration::from_millis(1500);
    // UI Automation can hang in a misbehaving application; do not wait long for it.
    const UI_AUTOMATION_TIMEOUT: Duration = Duration::from_millis(700);
    const MODIFIERS: [u16; 5] = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN];

    pub fn selected_text(context: Option<Arc<RunOutput>>) -> Result<String, String> {
        let started = Instant::now();
        let target = context.as_ref().and_then(|run| run.target)
            .ok_or("Выделите текст в другом приложении и повторите.")? as HWND;
        if unsafe { IsWindow(target) } == 0 {
            return Err("Окно с выделенным текстом уже закрыто.".into());
        }
        if unsafe { GetForegroundWindow() } != target {
            if unsafe { SetForegroundWindow(target) } == 0 {
                return Err("Windows не разрешила вернуться в окно с выделенным текстом.".into());
            }
            std::thread::sleep(Duration::from_millis(80));
        }

        if let Some(text) = ui_automation_selection().filter(|text| !text.trim().is_empty()) {
            log::info!("selection: UI Automation, {} ms, {}", started.elapsed().as_millis(), preview(&text));
            return Ok(text.trim().to_owned());
        }

        release_modifiers();
        let console = is_console_window(target);
        let copied = copy_selection(context, move || send_copy(console))?;
        match copied.map(|text| text.trim().to_owned()).filter(|text| !text.is_empty()) {
            Some(text) => {
                log::info!("selection: copy command, {} ms, {}", started.elapsed().as_millis(), preview(&text));
                Ok(text)
            }
            None => {
                log::info!("selection: nothing selected, {} ms", started.elapsed().as_millis());
                Err("Нет выделенного текста. Выделите текст и повторите.".into())
            }
        }
    }

    fn held_modifiers() -> Vec<u16> {
        MODIFIERS.iter().copied().filter(|&key| unsafe { GetAsyncKeyState(key as i32) } < 0).collect()
    }

    fn release_modifiers() {
        let deadline = Instant::now() + MODIFIER_RELEASE_TIMEOUT;
        while !held_modifiers().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Still held: make the system see them released so the copy is a plain one.
        let held: Vec<(u16, bool, bool)> = held_modifiers().into_iter().map(|key| (key, true, false)).collect();
        if !held.is_empty() {
            log::warn!("selection: hotkey modifiers still held, releasing them for the copy");
            let _ = send_keys(&held);
        }
    }

    // Ctrl+C, except in consoles where it interrupts the program: Ctrl+Insert copies there.
    fn send_copy(console: bool) -> Result<(), String> {
        let key = if console { (VK_INSERT, false, true) } else { (VK_C, false, false) };
        send_keys(&[
            (VK_CONTROL, false, false),
            key,
            (key.0, true, key.2),
            (VK_CONTROL, true, false),
        ])
    }

    // (virtual key, key up, extended key)
    fn send_keys(events: &[(u16, bool, bool)]) -> Result<(), String> {
        let inputs: Vec<INPUT> = events.iter().map(|&(key, up, extended)| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: (if up { KEYEVENTF_KEYUP } else { 0 }) | (if extended { KEYEVENTF_EXTENDEDKEY } else { 0 }),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }).collect();
        let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        if sent != inputs.len() as u32 {
            return Err("Windows не отправила команду копирования в активное окно.".into());
        }
        Ok(())
    }

    // The selection of the focused control through its UI Automation text pattern.
    fn ui_automation_selection() -> Option<String> {
        let (sender, receiver) = std::sync::mpsc::channel();
        // A hung application must not hang the scenario: abandon the query instead.
        std::thread::Builder::new().name("selection-ui-automation".into()).spawn(move || {
            let _ = sender.send(query_ui_automation());
        }).ok()?;
        match receiver.recv_timeout(UI_AUTOMATION_TIMEOUT) {
            Ok(text) => text,
            Err(_) => {
                log::warn!("selection: UI Automation did not answer in {} ms", UI_AUTOMATION_TIMEOUT.as_millis());
                None
            }
        }
    }

    fn query_ui_automation() -> Option<String> {
        use windows::core::Interface;
        use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize};
        use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomationTextPattern, UIA_TextPatternId};
        unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() { return None; }
            let text = (|| -> windows::core::Result<Option<String>> {
                let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
                let element = automation.GetFocusedElement()?;
                let pattern: IUIAutomationTextPattern = element.GetCurrentPattern(UIA_TextPatternId)?.cast()?;
                let ranges = pattern.GetSelection()?;
                let mut parts = Vec::new();
                for index in 0..ranges.Length()? {
                    let text = ranges.GetElement(index)?.GetText(-1)?;
                    parts.push(text.to_string());
                }
                Ok(Some(parts.join("\n")))
            })();
            CoUninitialize();
            text.ok().flatten()
        }
    }
}
