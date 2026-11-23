use std::{path::PathBuf, sync::{atomic::{AtomicU64, Ordering}, Mutex}, thread::sleep, time::{Duration, Instant}};
use windows_sys::Win32::{Foundation::*, System::{Console::*, Diagnostics::ToolHelp::*}, Storage::FileSystem::*, UI::WindowsAndMessaging::*};

struct ConsoleProcess { handle: isize, pid: u32 }
impl ConsoleProcess {
    fn id(&self) -> u32 { self.pid }
    fn try_wait(&self) -> Result<Option<u32>, std::io::Error> {
        use windows_sys::Win32::System::Threading::GetExitCodeProcess;
        let mut status = 0;
        if unsafe { GetExitCodeProcess(self.handle as HANDLE, &mut status) } == 0 { return Err(std::io::Error::last_os_error()); }
        Ok((status != 259).then_some(status))
    }
    fn kill(&mut self) -> Result<(), std::io::Error> {
        if unsafe { windows_sys::Win32::System::Threading::TerminateProcess(self.handle as HANDLE, 1) } == 0 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }
    fn wait(&mut self) { unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(self.handle as HANDLE, 3000); } }
}
impl Drop for ConsoleProcess { fn drop(&mut self) { unsafe { CloseHandle(self.handle as HANDLE); } } }

struct ProcessJob(isize);
impl Drop for ProcessJob { fn drop(&mut self) { unsafe { CloseHandle(self.0 as HANDLE); } } }
impl ProcessJob {
    fn create() -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return Err(failure("Не удалось создать группу процессов диктовки")); }
            let job = Self(handle as isize);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0 {
                return Err(failure("Не удалось настроить закрытие диктовки"));
            }
            Ok(job)
        }
    }
    fn assign(&self, handle: HANDLE) -> Result<(), String> {
        if unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0 as HANDLE, handle) } == 0 {
            return Err(failure("Не удалось привязать процесс диктовки к приложению"));
        }
        Ok(())
    }
}

struct Session {
    child: ConsoleProcess,
    _job: ProcessJob,
    pid: u32,
    hwnd: isize,
    owner: Option<String>,
    mic_seen: bool,
    touched: Instant,
    live_misses: u32,
    placeholder: Option<String>,
}

static CHANGES: Mutex<Vec<(isize, u64)>> = Mutex::new(Vec::new());
static CHANGED: std::sync::Condvar = std::sync::Condvar::new();
const READ_GAP: Duration = Duration::from_millis(20);
const SAFETY_CHECK: Duration = Duration::from_millis(500);

unsafe extern "system" fn console_event(_: windows_sys::Win32::UI::Accessibility::HWINEVENTHOOK, _: u32, hwnd: HWND, _: i32, _: i32, _: u32, _: u32) {
    if let Ok(mut changes) = CHANGES.lock() {
        if let Some(entry) = changes.iter_mut().find(|(window, _)| *window == hwnd as isize) {
            entry.1 += 1;
            CHANGED.notify_all();
        }
    }
}

fn watch_console(hwnd: isize) {
    static WATCHER: std::sync::Once = std::sync::Once::new();
    WATCHER.call_once(|| {
        let started = std::thread::Builder::new().name("agy-console-events".into()).spawn(|| unsafe {
            use windows_sys::Win32::UI::Accessibility::SetWinEventHook;
            let hook = SetWinEventHook(EVENT_CONSOLE_CARET, EVENT_CONSOLE_END_APPLICATION, std::ptr::null_mut(),
                Some(console_event), 0, 0, WINEVENT_OUTOFCONTEXT);
            if hook.is_null() { log::warn!("Antigravity CLI: {}", failure("не удалось подписаться на изменения консоли")); return; }
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 { TranslateMessage(&message); DispatchMessageW(&message); }
        });
        if let Err(error) = started { log::warn!("Antigravity CLI: console watcher not started: {error}"); }
    });
    if let Ok(mut changes) = CHANGES.lock() {
        changes.retain(|(window, _)| unsafe { IsWindow(*window as HWND) != 0 });
        if !changes.iter().any(|(window, _)| *window == hwnd) { changes.push((hwnd, 0)); }
    }
}

struct ConsoleWait { hwnd: isize, seen: u64, last_read: Option<Instant> }
impl ConsoleWait {
    fn new(hwnd: isize) -> Self {
        let seen = CHANGES.lock().ok().and_then(|changes| changes.iter().find(|(window, _)| *window == hwnd).map(|entry| entry.1)).unwrap_or(0);
        Self { hwnd, seen, last_read: None }
    }
    fn next(&mut self, timeout: Duration, ready: impl Fn() -> bool) {
        let deadline = Instant::now() + timeout;
        if let Ok(mut changes) = CHANGES.lock() {
            loop {
                let count = changes.iter().find(|(window, _)| *window == self.hwnd).map_or(self.seen, |entry| entry.1);
                if count != self.seen { self.seen = count; break; }
                if ready() { return; }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() { break; }
                changes = match CHANGED.wait_timeout(changes, left) { Ok((changes, _)) => changes, Err(_) => return };
            }
        }
        if let Some(last) = self.last_read { sleep(READ_GAP.saturating_sub(last.elapsed())); }
        self.last_read = Some(Instant::now());
    }
}

const CONSOLES: usize = 2;
static SESSIONS: [Mutex<Option<Session>>; CONSOLES] = [Mutex::new(None), Mutex::new(None)];
const MAIN: usize = 0;

fn lock(index: usize) -> Result<std::sync::MutexGuard<'static, Option<Session>>, String> {
    SESSIONS[index].lock().map_err(|e| e.to_string())
}

fn owned_by(run_id: &str) -> Result<usize, String> {
    for index in 0..CONSOLES {
        if lock(index)?.as_ref().is_some_and(|s| s.owner.as_deref() == Some(run_id)) { return Ok(index); }
    }
    Err("Диктовка отменена".into())
}

static CANCELLED_RUNS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static CANCEL_ALL: AtomicU64 = AtomicU64::new(0);
const CANCELLED: &str = "Диктовка отменена";

fn forget_cancel(run_id: &str) {
    if let Ok(mut runs) = CANCELLED_RUNS.lock() { runs.retain(|id| id != run_id); }
}

static CONSOLE: Mutex<()> = Mutex::new(());
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
fn failure(label: &str) -> String { format!("{label}: {}", std::io::Error::last_os_error()) }

const VK_F5: u16 = 0x74;

fn agy_exe() -> Result<PathBuf, String> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local).join("agy/bin/agy.exe");
        if candidate.is_file() { return Ok(candidate); }
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = dir.join("agy.exe");
        if path.is_file() { return Ok(path); }
    }
    Err("Не найден agy.exe. Установите Antigravity CLI.".into())
}

fn check_auth() -> Result<(), String> {
    let profile = PathBuf::from(std::env::var_os("USERPROFILE").ok_or("Не найден профиль Windows")?);
    let cli_dir = profile.join(".gemini/antigravity-cli");
    let creds = cli_dir.join("oauth_creds.json");
    let accounts = cli_dir.join("google_accounts.json");
    let has_account = std::fs::read_to_string(&accounts).ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|json| json.get("active").and_then(|v| v.as_str()).map(|s| !s.trim().is_empty()))
        .unwrap_or(false);
    if !creds.is_file() || !has_account {
        return Err("Войдите в Antigravity CLI: нажмите «Открыть Antigravity CLI» в настройках шага и выполните вход.".into());
    }
    Ok(())
}

unsafe extern "system" fn find_window(hwnd: HWND, pointer: LPARAM) -> i32 {
    let query = unsafe { &mut *(pointer as *mut (u32, isize)) };
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid); }
    let mut class = [0u16; 64];
    let count = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    if pid == query.0 && String::from_utf16_lossy(&class[..count.max(0) as usize]) == "ConsoleWindowClass" {
        query.1 = hwnd as isize;
        return 0;
    }
    1
}

fn child_pid(parent: u32) -> Option<(u32, Vec<u32>)> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE { return None; }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut ok = Process32FirstW(snapshot, &mut entry);
        let mut entries = Vec::new();
        while ok != 0 {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            entries.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..len])));
            ok = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        let mut family = vec![parent];
        loop {
            let previous = family.len();
            for (pid, owner, _) in &entries {
                if family.contains(owner) && !family.contains(pid) { family.push(*pid); }
            }
            if previous == family.len() { break; }
        }
        entries.iter()
            .find(|(pid, _, name)| family.contains(pid) && name.eq_ignore_ascii_case("agy.exe"))
            .map(|(pid, _, _)| (*pid, family))
    }
}

fn microphone_active(pid: u32) -> Result<bool, String> {
    std::thread::spawn(move || microphone_active_here(pid))
        .join()
        .map_err(|_| "Проверка микрофона Antigravity CLI прервана".to_string())?
}

fn microphone_active_here(pid: u32) -> Result<bool, String> {
    use windows::{core::Interface, Win32::{Media::Audio::*, System::Com::*}};
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        if initialized.is_err() { return Err("Не удалось проверить микрофон Antigravity CLI".into()); }
        let result = (|| -> windows::core::Result<bool> {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
            for index in 0..devices.GetCount()? {
                let device = devices.Item(index)?;
                let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
                let sessions = manager.GetSessionEnumerator()?;
                for session_index in 0..sessions.GetCount()? {
                    let control = sessions.GetSession(session_index)?;
                    let control2: IAudioSessionControl2 = control.cast()?;
                    if control2.GetProcessId()? == pid && control.GetState()? == AudioSessionStateActive { return Ok(true); }
                }
            }
            Ok(false)
        })();
        CoUninitialize();
        result.map_err(|error| format!("Проверка микрофона: {error}"))
    }
}

fn with_console<T>(session: &Session, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = CONSOLE.lock().map_err(|e| e.to_string())?;
    unsafe {
        let standard_handles = [GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)];
        let mut processes = [0u32; 2];
        let had_console = GetConsoleProcessList(processes.as_mut_ptr(), processes.len() as u32) > 0;
        FreeConsole();
        let mut attached = AttachConsole(session.pid) != 0;
        let mut error = if attached { None } else { Some(failure("Не удалось подключиться к консоли Antigravity CLI")) };
        for _ in 0..10 {
            if attached { break; }
            sleep(Duration::from_millis(30));
            FreeConsole();
            if AttachConsole(session.pid) != 0 { attached = true; error = None; }
            else { error = Some(failure("Не удалось подключиться к консоли Antigravity CLI")); }
        }
        let restore_handles = || {
            for (kind, handle) in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].into_iter().zip(standard_handles) {
                SetStdHandle(kind, handle);
            }
        };
        let result = if let Some(error) = error {
            Err(error)
        } else {
            restore_handles();
            let result = operation();
            FreeConsole();
            result
        };
        if had_console { AttachConsole(ATTACH_PARENT_PROCESS); }
        restore_handles();
        result
    }
}

fn key(session: &Session, vk: u16, character: u16, controls: u32) -> Result<(), String> {
    with_console(session, || unsafe {
        let handle = CreateFileW(wide("CONIN$").as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
        let mut records: [INPUT_RECORD; 2] = std::mem::zeroed();
        for (index, down) in [1, 0].iter().enumerate() {
            records[index].EventType = KEY_EVENT as u16;
            records[index].Event.KeyEvent = KEY_EVENT_RECORD {
                bKeyDown: *down,
                wRepeatCount: 1,
                wVirtualKeyCode: vk,
                wVirtualScanCode: 0,
                uChar: KEY_EVENT_RECORD_0 { UnicodeChar: character },
                dwControlKeyState: controls,
            };
        }
        let mut written = 0;
        let ok = handle != INVALID_HANDLE_VALUE && WriteConsoleInputW(handle, records.as_ptr(), 2, &mut written) != 0;
        if handle != INVALID_HANDLE_VALUE { CloseHandle(handle); }
        if ok && written == 2 { Ok(()) } else { Err(failure("Не удалось передать клавишу в Antigravity CLI")) }
    })
}

fn screen(session: &Session) -> Result<Vec<u16>, String> {
    with_console(session, || unsafe {
        let handle = CreateFileW(wide("CONOUT$").as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
        if handle == INVALID_HANDLE_VALUE { return Err(failure("Не удалось прочитать консоль Antigravity CLI")); }
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
        let mut text = Vec::new();
        if GetConsoleScreenBufferInfo(handle, &mut info) != 0 {
            let window = info.srWindow;
            let width = (window.Right - window.Left + 1).max(0) as usize;
            let mut row = vec![0u16; width];
            for y in window.Top..=window.Bottom {
                let mut read = 0;
                ReadConsoleOutputCharacterW(handle, row.as_mut_ptr(), width as u32, COORD { X: window.Left, Y: y }, &mut read);
                text.extend_from_slice(&row[..read as usize]);
                text.push(u16::from(b'\n'));
            }
        }
        CloseHandle(handle);
        Ok(text)
    })
}

const PROMPT_MARKERS: [char; 2] = ['❯', '>'];
fn is_prompt_row(row: &str) -> bool { row.trim_start().starts_with(PROMPT_MARKERS) }

fn is_placeholder(text: &str, known_placeholder: Option<&str>) -> bool {
    if text.is_empty() { return true; }
    if known_placeholder.is_some_and(|p| p == text) { return true; }
    text.contains("(shift+tab to cycle)")
        || text.starts_with("Type your message")
        || text.starts_with("Auto mode:")
        || text.starts_with("Plan mode:")
}

// Raw prompt text inside the `────` box, without filtering placeholder.
fn prompt_raw(screen: &[u16]) -> Option<String> {
    let text = String::from_utf16_lossy(screen);
    let rows: Vec<&str> = text.lines().collect();
    let start = rows.iter().rposition(|row| is_prompt_row(row))?;
    let first = rows[start].trim_start();
    let mut parts = vec![first.strip_prefix(PROMPT_MARKERS).unwrap_or(first)];
    let mut closed = false;
    for row in rows.iter().skip(start + 1).take(30) {
        let trimmed = row.trim();
        if !trimmed.is_empty() && trimmed.chars().all(|c| c == '─') { closed = true; break; }
        parts.push(row);
    }
    if !closed { return None; }
    let joined = parts.iter().map(|part| part.trim()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    Some(joined)
}

fn prompt_text(screen: &[u16], known_placeholder: Option<&str>) -> Option<String> {
    let raw = prompt_raw(screen)?;
    if is_placeholder(&raw, known_placeholder) { Some(String::new()) } else { Some(raw) }
}

fn is_dictating(screen: &[u16]) -> bool {
    let text = String::from_utf16_lossy(screen);
    let rows: Vec<&str> = text.lines().collect();
    let Some(start) = rows.iter().rposition(|row| is_prompt_row(row)) else { return false };
    rows.iter().skip(start + 1).any(|row| {
        let trimmed = row.trim();
        trimmed.contains("Recording ") && trimmed.contains("to insert")
            || trimmed.contains("Connecting") && (trimmed.contains("esc to") || trimmed.contains("voice"))
    })
}

fn screen_tail(screen: &[u16]) -> String {
    let text = String::from_utf16_lossy(screen);
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = flat.chars().count();
    format!("«{}»", flat.chars().skip(count.saturating_sub(160)).collect::<String>())
}

fn clear_prompt(session: &Session) -> Result<(), String> { clear_prompt_unless(session, &|| false) }

fn clear_input_keys(session: &Session) -> Result<(), String> {
    key(session, 0x45, 0x05, LEFT_CTRL_PRESSED)?; // Ctrl+E: end of line
    key(session, 0x55, 0x15, LEFT_CTRL_PRESSED)?; // Ctrl+U: delete to start
    key(session, 0x4b, 0x0b, LEFT_CTRL_PRESSED)?; // Ctrl+K: delete to end
    key(session, 0x08, 0x08, 0)?; // Backspace
    Ok(())
}

fn clear_prompt_unless(session: &Session, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    let mut changes = ConsoleWait::new(session.hwnd);
    if screen(session).ok().as_deref().and_then(|s| prompt_text(s, session.placeholder.as_deref())).is_some_and(|t| t.is_empty()) {
        return Ok(());
    }
    clear_input_keys(session)?;
    for attempt in 0..40 {
        if attempt > 0 && cancelled() {
            log::info!("Antigravity CLI start cancelled while clearing the prompt");
            return Err(CANCELLED.into());
        }
        match screen(session).ok().as_deref().and_then(|s| prompt_text(s, session.placeholder.as_deref())) {
            Some(text) if text.is_empty() => return Ok(()),
            Some(_) => {}
            None => return clear_input_keys(session),
        }
        clear_input_keys(session)?;
        changes.next(SAFETY_CHECK, || false);
    }
    let left = screen(session).ok().as_deref().and_then(|s| prompt_text(s, session.placeholder.as_deref())).unwrap_or_default();
    log::warn!("Antigravity CLI prompt could not be cleared: {}", super::super::clipboard_history::preview(&left));
    Err("Не удалось очистить строку ввода Antigravity CLI перед записью.".into())
}

pub struct Poll { pub finished: bool, pub text: Option<String> }

fn live_text(session: &mut Session) -> Option<String> {
    let screen = screen(session).ok()?;
    let text = prompt_text(&screen, session.placeholder.as_deref());
    if text.is_none() {
        session.live_misses += 1;
        if session.live_misses == 4 {
            log::warn!("Antigravity CLI live text: prompt not found on screen, live preview unavailable; screen ends with {}", screen_tail(&screen));
        }
    }
    text
}

fn ensure(slot: &mut Option<Session>, visible: bool) -> Result<&mut Session, String> {
    let alive = slot.as_mut().is_some_and(|s| s.child.try_wait().ok().flatten().is_none() && unsafe { IsWindow(s.hwnd as HWND) != 0 });
    if !alive {
        if let Some(mut old) = slot.take() { let _ = old.child.kill(); let _ = old.child.wait(); }
        let exe = agy_exe()?;
        if !visible { check_auth()?; }
        let work_dir = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let conhost = PathBuf::from(std::env::var_os("SystemRoot").ok_or("Не найден Windows")?).join("System32/conhost.exe");
        let target = unsafe { GetForegroundWindow() };
        let job = ProcessJob::create()?;
        let parameters = wide(&format!("\"{}\"", exe.display()));
        let executable = wide(&conhost.to_string_lossy());
        let directory = wide(&work_dir.to_string_lossy());
        let mut info: windows_sys::Win32::UI::Shell::SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of_val(&info) as u32;
        info.fMask = windows_sys::Win32::UI::Shell::SEE_MASK_NOCLOSEPROCESS | windows_sys::Win32::UI::Shell::SEE_MASK_NOASYNC;
        info.lpFile = executable.as_ptr();
        info.lpParameters = parameters.as_ptr();
        info.lpDirectory = directory.as_ptr();
        info.nShow = SW_SHOWNOACTIVATE;
        if unsafe { windows_sys::Win32::UI::Shell::ShellExecuteExW(&mut info) } == 0 {
            return Err(failure("Не удалось запустить консоль Antigravity CLI"));
        }
        let mut child = ConsoleProcess { handle: info.hProcess as isize, pid: unsafe { windows_sys::Win32::System::Threading::GetProcessId(info.hProcess) } };
        job.assign(info.hProcess)?;
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut found = None;
        while Instant::now() < deadline {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() { break; }
            if let Some((pid, family)) = child_pid(child.id()) {
                for owner in family {
                    let mut query = (owner, 0isize);
                    unsafe { EnumWindows(Some(find_window), &mut query as *mut _ as isize); }
                    if query.1 != 0 { found = Some((pid, query.1)); break; }
                }
                if found.is_some() { break; }
            }
            sleep(Duration::from_millis(100));
        }
        let Some((pid, hwnd)) = found else {
            let status = child.try_wait().ok().flatten();
            let _ = child.kill();
            child.wait();
            return Err(format!("Не найдена классическая консоль Antigravity CLI (код завершения: {status:?})."));
        };
        unsafe {
            use windows_sys::Win32::System::Threading::{OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION};
            let process = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
            if !process.is_null() {
                let _ = SetPriorityClass(process, ABOVE_NORMAL_PRIORITY_CLASS);
                CloseHandle(process);
            }
        }
        unsafe {
            ShowWindow(hwnd as HWND, if visible { SW_SHOW } else { SW_HIDE });
            if !visible && !target.is_null() { SetForegroundWindow(target); }
        }
        let mut session = Session {
            child, _job: job, pid, hwnd, owner: None, mic_seen: false,
            touched: Instant::now(), live_misses: 0, placeholder: None,
        };
        watch_console(hwnd);
        let mut changes = ConsoleWait::new(hwnd);
        log::info!("Antigravity CLI console started (pid {pid})");
        let ready_deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = session.child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!("Antigravity CLI завершился при запуске: {status}"));
            }
            if visible { break; }
            if unsafe { IsWindow(session.hwnd as HWND) } == 0 {
                let _ = session.child.kill();
                session.child.wait();
                return Err("Окно Antigravity CLI закрылось при запуске.".into());
            }
            let current = screen(&session).ok();
            if let Some(raw) = current.as_deref().and_then(prompt_raw) {
                if !raw.is_empty() { session.placeholder = Some(raw); }
                break;
            }
            if Instant::now() > ready_deadline {
                let tail = current.as_deref().map(screen_tail).unwrap_or_default();
                let _ = session.child.kill();
                session.child.wait();
                return Err(format!("Antigravity CLI не показал строку ввода. Откройте его окно в настройках шага и завершите вход или первоначальную настройку. Экран: {tail}"));
            }
            changes.next(SAFETY_CHECK, || false);
        }
        *slot = Some(session);
    }
    let session = slot.as_mut().unwrap();
    if visible { unsafe { ShowWindow(session.hwnd as HWND, SW_RESTORE); SetForegroundWindow(session.hwnd as HWND); } }
    Ok(session)
}

pub fn prepare(enabled: bool) -> Result<(), String> {
    if enabled {
        ensure(&mut *lock(MAIN)?, false)?;
        std::thread::spawn(|| {
            for index in (0..CONSOLES).filter(|&index| index != MAIN) {
                if let Ok(mut slot) = lock(index) {
                    if let Err(error) = ensure(&mut slot, false) { log::warn!("Antigravity CLI: spare console {index} not started: {error}"); }
                }
            }
        });
        return Ok(());
    }
    for index in 0..CONSOLES {
        let mut slot = lock(index)?;
        if slot.as_ref().is_some_and(|session| session.owner.is_none()) {
            if let Some(mut session) = slot.take() {
                log::info!("Antigravity CLI: no scenario uses it, closing dictation console {index}");
                let _ = session.child.kill();
                session.child.wait();
            }
        }
    }
    Ok(())
}

pub fn open(visible: bool) -> Result<(), String> { ensure(&mut *lock(MAIN)?, visible).map(|_| ()) }

pub fn hide() -> Result<(), String> {
    if let Some(s) = lock(MAIN)?.as_ref() {
        if s.hwnd != 0 && unsafe { IsWindow(s.hwnd as HWND) != 0 } {
            unsafe { ShowWindow(s.hwnd as HWND, SW_HIDE); }
        }
    }
    Ok(())
}

pub fn visible() -> Result<bool, String> {
    Ok(lock(MAIN)?.as_mut().is_some_and(|s| {
        s.child.try_wait().ok().flatten().is_none()
            && s.hwnd != 0
            && unsafe { IsWindow(s.hwnd as HWND) != 0 && IsWindowVisible(s.hwnd as HWND) != 0 }
    }))
}

pub fn running() -> Result<bool, String> {
    for index in 0..CONSOLES {
        if lock(index)?.as_ref().is_some_and(|s| unsafe { IsWindow(s.hwnd as HWND) != 0 }) { return Ok(true); }
    }
    Ok(false)
}

fn busy(s: &Session, run_id: &str) -> bool {
    let Some(owner) = s.owner.as_deref() else { return false };
    let registered = super::super::scenario_output::RUNS.lock().map(|runs| runs.contains_key(owner)).unwrap_or(false);
    owner != run_id && registered && s.touched.elapsed() < Duration::from_secs(3)
}

pub fn start(run_id: &str) -> Result<(), String> {
    forget_cancel(run_id);
    let epoch = CANCEL_ALL.load(Ordering::SeqCst);
    let cancelled = || CANCEL_ALL.load(Ordering::SeqCst) != epoch
        || CANCELLED_RUNS.lock().map(|runs| runs.iter().any(|id| id == run_id)).unwrap_or(false);
    let result = start_dictation(run_id, &cancelled);
    forget_cancel(run_id);
    result
}

fn start_dictation(run_id: &str, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    let requested = Instant::now();
    let mut chosen = None;
    'search: for pass in 0..2 {
        for index in 0..CONSOLES {
            let slot = lock(index)?;
            if slot.as_ref().map_or(pass == 1, |s| !busy(s, run_id)) { chosen = Some((index, slot)); break 'search; }
        }
    }
    let Some((index, mut slot)) = chosen else { return Err("Antigravity CLI уже занят диктовкой.".into()) };
    let waited = requested.elapsed();
    let launched = slot.is_none();
    log::info!("Antigravity CLI start: console {index} taken after {} ms, launching={launched}", waited.as_millis());
    let s = ensure(&mut slot, false)?;
    if let Some(owner) = s.owner.clone() {
        log::warn!("Antigravity CLI: releasing stale dictation of run {owner} on console {index} (idle {} ms)", s.touched.elapsed().as_millis());
        let _ = key(s, 0x1b, 0x1b, 0);
        s.owner = None;
    }
    if cancelled() { return Err(CANCELLED.into()); }
    let begun = Instant::now();
    clear_prompt_unless(s, cancelled)?;
    let cleared = begun.elapsed();
    if cancelled() { return Err(CANCELLED.into()); }
    key(s, VK_F5, 0, 0)?;
    log::info!("Antigravity CLI start: F5 sent, waiting for the microphone");
    s.owner = Some(run_id.to_owned());
    s.mic_seen = false;
    s.touched = Instant::now();
    s.live_misses = 0;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if cancelled() {
            let _ = key(s, 0x1b, 0x1b, 0);
            s.owner = None;
            return Err(CANCELLED.into());
        }
        if microphone_active(s.pid).unwrap_or(false) {
            s.mic_seen = true;
            log::info!("Antigravity CLI recording started: prompt cleared in {} ms, microphone opened {} ms after F5",
                cleared.as_millis(), (begun.elapsed() - cleared).as_millis());
            return Ok(());
        }
        sleep(Duration::from_millis(40));
    }
    log::warn!("Antigravity CLI start: microphone did not open within 5 s");
    let _ = key(s, 0x1b, 0x1b, 0);
    s.owner = None;
    unsafe { ShowWindow(s.hwnd as HWND, SW_RESTORE); }
    Err("Antigravity CLI не включил микрофон. Откройте его окно в настройках шага и проверьте вход (/logout и повторный вход).".into())
}

pub fn finished(run_id: &str, live: bool, known: Option<&str>) -> Result<Poll, String> {
    let index = owned_by(run_id)?;
    let hwnd = lock(index)?.as_ref().map(|s| s.hwnd).ok_or("Сеанс Antigravity CLI закрыт")?;
    let mut changes = ConsoleWait::new(hwnd);
    let deadline = Instant::now() + SAFETY_CHECK;
    let mut next_microphone = Instant::now();
    loop {
        {
            let mut slot = lock(index)?;
            let s = slot.as_mut().ok_or("Сеанс Antigravity CLI закрыт")?;
            if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
            s.touched = Instant::now();
            if unsafe { IsWindow(s.hwnd as HWND) } == 0 { return Err("Окно Antigravity CLI закрыто".into()); }
            if Instant::now() >= next_microphone {
                next_microphone = Instant::now() + Duration::from_millis(250);
                if s.mic_seen && !microphone_active(s.pid)? { return Ok(Poll { finished: true, text: None }); }
            }
            let text = if live { live_text(s) } else { None };
            if text.is_some() && text.as_deref() != known || Instant::now() >= deadline {
                return Ok(Poll { finished: false, text });
            }
        }
        let wake = deadline.min(next_microphone).saturating_duration_since(Instant::now());
        changes.next(wake, || false);
    }
}

pub fn stop(run_id: &str, tail: Duration, first_word: Duration) -> Result<String, String> {
    let deadline = Instant::now() + tail;
    let first_word_deadline = Instant::now() + first_word;
    let index = owned_by(run_id)?;
    let (pid, hwnd) = {
        let slot = lock(index)?;
        let s = slot.as_ref().ok_or("Сеанс Antigravity CLI закрыт")?;
        if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
        (s.pid, s.hwnd)
    };
    let mut changes = ConsoleWait::new(hwnd);
    sleep(deadline.saturating_duration_since(Instant::now()).saturating_sub(Duration::from_millis(25)));
    let mut mic = microphone_active(pid)?;
    sleep(deadline.saturating_duration_since(Instant::now()));

    if mic && !first_word.is_zero() {
        let mut waited = false;
        loop {
            let mut slot = lock(index)?;
            let s = slot.as_mut().ok_or("Сеанс Antigravity CLI закрыт")?;
            if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
            s.touched = Instant::now();
            let empty = screen(s).ok().as_deref()
                .and_then(|scr| prompt_text(scr, s.placeholder.as_deref()))
                .is_some_and(|text| text.is_empty());
            if !empty { break; }
            if Instant::now() >= first_word_deadline {
                if microphone_active(s.pid).unwrap_or(false) { let _ = key(s, 0x1b, 0x1b, 0); }
                log::info!("Antigravity CLI: no word {} ms after stop, no speech", first_word.as_millis());
                s.owner = None;
                return Err("Речь не распознана.".into());
            }
            waited = true;
            drop(slot);
            changes.next(SAFETY_CHECK.min(first_word_deadline.saturating_duration_since(Instant::now())), || false);
        }
        if waited { mic = microphone_active(pid)?; }
    }

    {
        let slot = lock(index)?;
        let s = slot.as_ref().ok_or("Сеанс Antigravity CLI закрыт")?;
        if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
        let dictating = screen(s).ok().as_deref().is_some_and(is_dictating);
        // Enter stops dictation and leaves the transcript in the prompt box without submitting.
        if mic || dictating { key(s, 0x0d, 0x0d, 0)?; }
        log::info!("Antigravity CLI stop: microphone active={mic}, dictating={dictating}");
    }

    const SETTLE_WINDOW: Duration = Duration::from_millis(220);
    let started = Instant::now();
    let mut settled: Option<(Instant, String)> = None;
    loop {
        let wait_for = {
            let mut slot = lock(index)?;
            let s = slot.as_mut().ok_or("Сеанс Antigravity CLI закрыт")?;
            if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
            s.touched = Instant::now();
            let current = screen(s).ok();
            let dictating = current.as_deref().is_some_and(is_dictating);
            let mic_on = microphone_active(s.pid).unwrap_or(false);
            if !dictating && !mic_on {
                let text = current.as_deref()
                    .and_then(|scr| prompt_text(scr, s.placeholder.as_deref()))
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                let since = match settled.as_mut() {
                    Some((since, prev)) if *prev == text => *since,
                    Some(entry) => {
                        *entry = (Instant::now(), text.clone());
                        entry.0
                    }
                    None => settled.insert((Instant::now(), text.clone())).0,
                };
                if since.elapsed() >= SETTLE_WINDOW {
                    s.owner = None;
                    let _ = clear_prompt(s);
                    log::info!("Antigravity CLI transcript received after {} ms: {}",
                        started.elapsed().as_millis(),
                        super::super::clipboard_history::preview(&text));
                    if text.is_empty() { return Err("Речь не распознана.".into()); }
                    return Ok(text);
                }
                SETTLE_WINDOW.saturating_sub(since.elapsed())
            } else {
                settled = None;
                Duration::from_millis(100)
            }
        };
        if started.elapsed() > Duration::from_secs(15) {
            let mut slot = lock(index)?;
            if let Some(s) = slot.as_mut() {
                let tail = screen(s).ok().as_deref().map(screen_tail).unwrap_or_default();
                let _ = key(s, 0x1b, 0x1b, 0);
                s.owner = None;
                return Err(format!("Antigravity CLI не завершил диктовку за 15 с. Экран: {tail}"));
            }
            return Err("Сеанс Antigravity CLI закрыт".into());
        }
        changes.next(wait_for, || false);
    }
}

pub fn cancel(run_id: Option<&str>) -> Result<(), String> {
    match run_id {
        Some(run_id) => if let Ok(mut runs) = CANCELLED_RUNS.lock() { runs.push(run_id.to_owned()); },
        None => { CANCEL_ALL.fetch_add(1, Ordering::SeqCst); }
    }
    let result = (|| {
        let mut result = Ok(());
        for index in 0..CONSOLES {
            let mut slot = lock(index)?;
            let Some(s) = slot.as_mut() else { continue };
            if run_id.map_or(s.owner.is_none(), |run_id| s.owner.as_deref() != Some(run_id)) { continue; }
            log::info!("Antigravity CLI: dictation cancelled on console {index}");
            if let Err(error) = key(s, 0x1b, 0x1b, 0) { result = Err(error); }
            s.owner = None;
        }
        result
    })();
    if let Some(run_id) = run_id { forget_cancel(run_id); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(lines: &[&str]) -> Vec<u16> { lines.join("\n").encode_utf16().collect() }

    #[test]
    fn prompt_text_reads_dictated_input_and_ignores_placeholder() {
        let rule = "────────────────";
        let placeholder = "Auto mode: edits & safe commands auto-approved (shift+tab to cycle)";
        let empty = rows(&[rule, &format!("> {placeholder}"), rule, "? for shortcuts"]);
        assert_eq!(prompt_text(&empty, Some(placeholder)).as_deref(), Some(""));
        assert_eq!(prompt_text(&empty, None).as_deref(), Some(""));

        let dictated = rows(&[rule, "> Привет, это проверка", "  голосового ввода", rule, "○ Recording 00:03  enter or f5 to insert · esc to discard"]);
        assert_eq!(prompt_text(&dictated, Some(placeholder)).as_deref(), Some("Привет, это проверка голосового ввода"));
        assert!(is_dictating(&dictated));
    }

    #[test]
    fn is_dictating_detects_status_line_only_below_prompt() {
        let rule = "────────────────";
        let idle = rows(&[rule, "> Привет", rule, "? for shortcuts"]);
        assert!(!is_dictating(&idle));
        let connecting = rows(&[rule, "> ", rule, "Connecting… esc to cancel"]);
        assert!(is_dictating(&connecting));
    }
}
