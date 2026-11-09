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
        if unsafe { windows_sys::Win32::System::Threading::TerminateProcess(self.handle as HANDLE, 1) } == 0 { return Err(std::io::Error::last_os_error()); } Ok(())
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
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0 { return Err(failure("Не удалось настроить закрытие диктовки")); }
            Ok(job)
        }
    }
    fn assign(&self, handle: HANDLE) -> Result<(), String> {
        if unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0 as HANDLE, handle) } == 0 { return Err(failure("Не удалось привязать процесс диктовки к приложению")); } Ok(())
    }
}
struct Session { child: ConsoleProcess, _job: ProcessJob, pid: u32, hwnd: isize, dir: PathBuf, owner: Option<String>, mic_seen: bool,
    // Last sign of life from the owning run: start, polling while recording, stop.
    touched: Instant,
    // Live text polls this recording that did not find the prompt.
    live_misses: u32,
    // The Claude Code version this console runs, for errors.
    version: String }

// Console change events. conhost raises EVENT_CONSOLE_* WinEvents for every
// change of its window, hidden or not; a watcher thread counts them per
// dictation console, and the waits below wake on them instead of polling.
static CHANGES: Mutex<Vec<(isize, u64)>> = Mutex::new(Vec::new());
static CHANGED: std::sync::Condvar = std::sync::Condvar::new();
// A burst of events (the microphone level drawn in the prompt) costs one read.
const READ_GAP: Duration = Duration::from_millis(20);
// Guards against a missed event.
const SAFETY_CHECK: Duration = Duration::from_millis(500);

unsafe extern "system" fn console_event(_: windows_sys::Win32::UI::Accessibility::HWINEVENTHOOK, _: u32, hwnd: HWND, _: i32, _: i32, _: u32, _: u32) {
    if let Ok(mut changes) = CHANGES.lock() {
        if let Some(entry) = changes.iter_mut().find(|(window, _)| *window == hwnd as isize) {
            entry.1 += 1;
            CHANGED.notify_all();
        }
    }
}

// Starts counting changes of this console window (and the watcher on first use).
fn watch_console(hwnd: isize) {
    static WATCHER: std::sync::Once = std::sync::Once::new();
    WATCHER.call_once(|| {
        let started = std::thread::Builder::new().name("claude-console-events".into()).spawn(|| unsafe {
            use windows_sys::Win32::UI::Accessibility::SetWinEventHook;
            let hook = SetWinEventHook(EVENT_CONSOLE_CARET, EVENT_CONSOLE_END_APPLICATION, std::ptr::null_mut(),
                Some(console_event), 0, 0, WINEVENT_OUTOFCONTEXT);
            if hook.is_null() { log::warn!("Claude Code: {}", failure("не удалось подписаться на изменения консоли")); return; }
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 { TranslateMessage(&message); DispatchMessageW(&message); }
        });
        if let Err(error) = started { log::warn!("Claude Code: console watcher not started: {error}"); }
    });
    if let Ok(mut changes) = CHANGES.lock() {
        changes.retain(|(window, _)| unsafe { IsWindow(*window as HWND) != 0 });
        if !changes.iter().any(|(window, _)| *window == hwnd) { changes.push((hwnd, 0)); }
    }
}

// Wakes waiters for something other than a screen change (the hook's transcript).
fn wake_console_waiters() {
    let _changes = CHANGES.lock();
    CHANGED.notify_all();
}

// Waits for the next change of one console window.
struct ConsoleWait { hwnd: isize, seen: u64, last_read: Option<Instant> }
impl ConsoleWait {
    fn new(hwnd: isize) -> Self {
        let seen = CHANGES.lock().ok().and_then(|changes| changes.iter().find(|(window, _)| *window == hwnd).map(|entry| entry.1)).unwrap_or(0);
        Self { hwnd, seen, last_read: None }
    }
    // Returns once the console changed, `ready()` holds (checked under the same
    // lock the hook's wake takes, so a wake is never missed) or `timeout` passed.
    fn next(&mut self, timeout: Duration, ready: impl Fn() -> bool) {
        let deadline = Instant::now() + timeout;
        if let Ok(mut changes) = CHANGES.lock() {
            loop {
                let count = changes.iter().find(|(window, _)| *window == self.hwnd).map_or(self.seen, |entry| entry.1);
                if count != self.seen { self.seen = count; break; }
                // Not a screen read: no gap to keep.
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
// Two hidden consoles: while one finishes the previous phrase (Claude finalizes
// it on its server for about half a second after the stop), the next recording
// starts at once in the other. One console cannot do both: a new recording
// clears its prompt, which still holds the previous phrase.
const CONSOLES: usize = 2;
static SESSIONS: [Mutex<Option<Session>>; CONSOLES] = [Mutex::new(None), Mutex::new(None)];
// The dictation console the user signs in through, shown by «Открыть Claude Code».
const MAIN: usize = 0;
fn lock(index: usize) -> Result<std::sync::MutexGuard<'static, Option<Session>>, String> {
    SESSIONS[index].lock().map_err(|e| e.to_string())
}
// The console that records or finishes the given run.
fn owned_by(run_id: &str) -> Result<usize, String> {
    for index in 0..CONSOLES {
        if lock(index)?.as_ref().is_some_and(|s| s.owner.as_deref() == Some(run_id)) { return Ok(index); }
    }
    Err("Диктовка отменена".into())
}
// Cancellation requested while start() holds the console lock. cancel() takes
// that lock too, so a startup that waits on Claude would otherwise delay the
// cancel until it finished by itself.
static CANCELLED_RUNS: Mutex<Vec<String>> = Mutex::new(Vec::new());
// Raised by a cancel without a run id: every startup in progress stops.
static CANCEL_ALL: AtomicU64 = AtomicU64::new(0);
const CANCELLED: &str = "Диктовка отменена";

fn forget_cancel(run_id: &str) {
    if let Ok(mut runs) = CANCELLED_RUNS.lock() { runs.retain(|id| id != run_id); }
}

// AttachConsole is process-wide. Never use it concurrently with another transport.
static CONSOLE: Mutex<()> = Mutex::new(());
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
fn failure(label: &str) -> String { format!("{label}: {}", std::io::Error::last_os_error()) }

// The Claude Code version dictation was checked with. Dictation reads Claude's
// screen, which another version may draw differently; it still runs, with a
// warning. Change it after checking dictation with a newer version.
const CHECKED_VERSION: &str = "2.1.310";

fn claude_exe() -> Result<PathBuf, String> {
    let local = PathBuf::from(std::env::var_os("USERPROFILE").ok_or("Не найден профиль Windows")?).join(".local/bin/claude.exe");
    if local.is_file() { return Ok(local); }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = dir.join("claude.exe"); if path.is_file() { return Ok(path); }
    }
    Err("Не найден claude.exe. Установите Claude Code.".into())
}

// The version from the executable's version resource («2.1.310.0» → «2.1.310»),
// read without starting it.
fn exe_version(exe: &std::path::Path) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO};
    let path = wide(&exe.to_string_lossy());
    unsafe {
        let size = GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut());
        if size == 0 { return None; }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) == 0 { return None; }
        let mut info: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if VerQueryValueW(data.as_ptr().cast(), wide("\\").as_ptr(), &mut info, &mut len) == 0 || info.is_null() { return None; }
        let info = &*(info as *const VS_FIXEDFILEINFO);
        Some(format!("{}.{}.{}", info.dwFileVersionMS >> 16, info.dwFileVersionMS & 0xffff, info.dwFileVersionLS >> 16))
    }
}

unsafe extern "system" fn find_window(hwnd: HWND, pointer: LPARAM) -> i32 {
    let query = unsafe { &mut *(pointer as *mut (u32, isize)) };
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid); }
    let mut class = [0u16; 64];
    let count = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    if pid == query.0 && String::from_utf16_lossy(&class[..count.max(0) as usize]) == "ConsoleWindowClass" {
        query.1 = hwnd as isize; return 0;
    }
    1
}

fn child_pid(parent: u32) -> Option<(u32, Vec<u32>)> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE { return None; }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed(); entry.dwSize = std::mem::size_of_val(&entry) as u32;
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
            for (pid, owner, _) in &entries { if family.contains(owner) && !family.contains(pid) { family.push(*pid); } }
            if previous == family.len() { break; }
        }
        entries.iter().find(|(pid, _, name)| family.contains(pid) && name.eq_ignore_ascii_case("claude.exe"))
            .map(|(pid, _, _)| (*pid, family))
    }
}

// COM apartment is per thread and cpal (the parallel capture) sets its own on the
// pooled threads this runs on, so a mismatch breaks its audio client. A throwaway
// thread keeps the apartment of every pooled thread untouched.
fn microphone_active(pid: u32) -> Result<bool, String> {
    std::thread::spawn(move || microphone_active_here(pid)).join().map_err(|_| "Проверка микрофона Claude Code прервана".to_string())?
}

fn microphone_active_here(pid: u32) -> Result<bool, String> {
    use windows::{core::Interface, Win32::{Media::Audio::*, System::Com::*}};
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        if initialized.is_err() { return Err("Не удалось проверить микрофон Claude Code".into()); }
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
        CoUninitialize(); result.map_err(|error| format!("Проверка микрофона: {error}"))
    }
}

fn with_console<T>(session: &Session, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = CONSOLE.lock().map_err(|e| e.to_string())?;
    unsafe {
        let standard_handles = [GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)];
        // GUI release builds have no console; development builds may inherit one.
        // Remember it and restore it after using Claude's console.
        let mut processes = [0u32; 2];
        let had_console = GetConsoleProcessList(processes.as_mut_ptr(), processes.len() as u32) > 0;
        FreeConsole();
        // The console host sometimes refuses a moment after another attach/detach
        // (ERROR_INVALID_FUNCTION); a short retry is enough.
        let mut attached = AttachConsole(session.pid) != 0;
        let mut error = if attached { None } else { Some(failure("Не удалось подключиться к консоли Claude Code")) };
        for _ in 0..10 {
            if attached { break; }
            std::thread::sleep(Duration::from_millis(30));
            FreeConsole();
            if AttachConsole(session.pid) != 0 { attached = true; error = None; }
            else { error = Some(failure("Не удалось подключиться к консоли Claude Code")); }
        }
        let result = if let Some(error) = error {
            Err(error)
        } else {
            let result = operation();
            FreeConsole();
            result
        };
        if had_console { AttachConsole(ATTACH_PARENT_PROCESS); }
        for (kind, handle) in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE].into_iter().zip(standard_handles) { SetStdHandle(kind, handle); }
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
                bKeyDown: *down, wRepeatCount: 1, wVirtualKeyCode: vk, wVirtualScanCode: 0,
                uChar: KEY_EVENT_RECORD_0 { UnicodeChar: character }, dwControlKeyState: controls,
            };
        }
        let mut written = 0;
        let ok = handle != INVALID_HANDLE_VALUE && WriteConsoleInputW(handle, records.as_ptr(), 2, &mut written) != 0;
        if handle != INVALID_HANDLE_VALUE { CloseHandle(handle); }
        if ok && written == 2 { Ok(()) } else { Err(failure("Не удалось передать клавишу в Claude Code")) }
    })
}

// Visible characters of Claude's console. Used to see when the dictated text
// has settled in the prompt, instead of waiting a fixed time before Enter.
fn screen(session: &Session) -> Result<Vec<u16>, String> {
    with_console(session, || unsafe {
        let handle = CreateFileW(wide("CONOUT$").as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
        if handle == INVALID_HANDLE_VALUE { return Err(failure("Не удалось прочитать консоль Claude Code")); }
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

// Diagnostics: the distinct colour attributes of the prompt row's text, as hex
// «attr×count». Interim dictation text is drawn dimmed.
fn prompt_colours(session: &Session, screen: &[u16]) -> String {
    let text = String::from_utf16_lossy(screen);
    let rows: Vec<&str> = text.lines().collect();
    let Some(row) = rows.iter().rposition(|row| is_prompt_row(row)) else { return "-".into() };
    let chars: Vec<char> = rows[row].chars().collect();
    let read = with_console(session, || unsafe {
        let handle = CreateFileW(wide("CONOUT$").as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
        if handle == INVALID_HANDLE_VALUE { return Err(failure("Не удалось прочитать консоль Claude Code")); }
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = std::mem::zeroed();
        let mut attrs = vec![0u16; chars.len()];
        let mut count = 0;
        if GetConsoleScreenBufferInfo(handle, &mut info) != 0 {
            ReadConsoleOutputAttribute(handle, attrs.as_mut_ptr(), attrs.len() as u32,
                COORD { X: info.srWindow.Left, Y: info.srWindow.Top + row as i16 }, &mut count);
        }
        CloseHandle(handle);
        attrs.truncate(count as usize);
        Ok(attrs)
    });
    let Ok(attrs) = read else { return "?".into() };
    let mut seen: Vec<(u16, usize)> = Vec::new();
    for (c, attr) in chars.iter().zip(attrs) {
        if c.is_whitespace() || PROMPT_MARKERS.contains(c) || ('▁'..='█').contains(c) { continue; }
        match seen.iter_mut().find(|(a, _)| *a == attr) { Some((_, n)) => *n += 1, None => seen.push((attr, 1)) }
    }
    seen.iter().map(|(a, n)| format!("{a:04x}×{n}")).collect::<Vec<_>>().join(" ")
}

// Receives Claude's UserPromptSubmit hook, stores the prompt as transcript.txt
// in the session folder and blocks the prompt so it never reaches the model.
fn start_hook_server(dir: PathBuf) -> Result<String, String> {
    use std::hash::{BuildHasher, Hasher};
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // Unguessable path, so that other local programs cannot inject a transcript.
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    let token = format!("{:016x}{:016x}", hasher.finish(), std::collections::hash_map::RandomState::new().build_hasher().finish());
    let path = format!("/hook/{token}");
    let url = format!("http://127.0.0.1:{port}{path}");
    std::thread::Builder::new().name("claude-hook".into()).spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut reader = BufReader::new(&stream);
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() { continue; }
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" || line == "\n" { break; }
                if let Some((name, value)) = line.split_once(':') {
                    if name.trim().eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap_or(0); }
                }
            }
            let mut body = vec![0; length.min(16 * 1024 * 1024)];
            let valid = request_line.split_whitespace().nth(1) == Some(path.as_str()) && reader.read_exact(&mut body).is_ok();
            let response = if valid {
                let prompt = serde_json::from_slice::<serde_json::Value>(&body).ok()
                    .and_then(|value| value.get("prompt").and_then(|prompt| prompt.as_str()).map(|prompt| prompt.trim().to_owned()));
                log::info!("Claude Code hook received prompt {}", prompt.as_deref().map(super::super::clipboard_history::preview).unwrap_or_else(|| "(нет поля prompt)".into()));
                if let Some(text) = prompt.filter(|text| !text.is_empty()) {
                    let temporary = dir.join("transcript.tmp");
                    if std::fs::write(&temporary, text).is_ok() && std::fs::rename(&temporary, dir.join("transcript.txt")).is_ok() {
                        wake_console_waiters();
                    }
                }
                let body = r#"{"decision":"block","reason":"[dictation] captured"}"#;
                format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
            } else {
                log::warn!("Claude Code hook: rejected request {}", request_line.trim());
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_owned()
            };
            let _ = stream.write_all(response.as_bytes());
        }
    }).map_err(|e| e.to_string())?;
    Ok(url)
}

// Claude draws the prompt marker as `❯` when the console is known to support
// Unicode and as `>` otherwise. The release app, started from Explorer or at
// sign-in rather than from a terminal, gets `>`, and then no `❯` ever appears.
const PROMPT_MARKERS: [char; 2] = ['❯', '>'];

fn is_prompt_row(row: &str) -> bool { row.trim_start().starts_with(PROMPT_MARKERS) }

// The prompt text Claude shows while dictating. Claude has no API for the
// interim transcript, so this reads its rendering, relying only on the prompt
// marker and the `────` rule below the (possibly wrapped) input.
// None means the layout was not recognised (e.g. after a Claude update).
fn prompt_text(screen: &[u16]) -> Option<String> {
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
    // The microphone level indicator is drawn at the end of the input.
    Some(joined.trim_end_matches(|c: char| c.is_whitespace() || ('▁'..='█').contains(&c)).to_owned())
}

// Empties Claude's prompt. Ctrl+U only erases the current line, and a long
// restored prompt spans several, so erase and join lines until the screen shows
// an empty prompt. Tap-to-record starts only on an empty prompt; otherwise
// Space would type a space instead of starting the microphone.
fn clear_prompt(session: &Session) -> Result<(), String> { clear_prompt_unless(session, &|| false) }

// Stops between passes once `cancelled` holds: up to 40 passes may take 20 s.
fn clear_prompt_unless(session: &Session, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    let mut changes = ConsoleWait::new(session.hwnd);
    for attempt in 0..40 {
        if attempt > 0 && cancelled() {
            log::info!("Claude Code start cancelled while clearing the prompt");
            return Err(CANCELLED.into());
        }
        match screen(session).ok().as_deref().and_then(prompt_text) {
            Some(text) if text.is_empty() => {
                if attempt > 0 { log::info!("Claude Code prompt cleared after {attempt} passes"); }
                return Ok(());
            }
            Some(_) => {}
            // Unknown layout: the best we can do without the screen.
            None => return key(session, 0x55, 0x15, LEFT_CTRL_PRESSED),
        }
        key(session, 0x55, 0x15, LEFT_CTRL_PRESSED)?;
        key(session, 0x08, 0x08, 0)?;
        changes.next(SAFETY_CHECK, || false);
    }
    let left = screen(session).ok().as_deref().and_then(prompt_text).unwrap_or_default();
    log::warn!("Claude Code prompt could not be cleared: {}", super::super::clipboard_history::preview(&left));
    Err("Не удалось очистить строку ввода Claude Code перед записью.".into())
}

pub struct Poll { pub finished: bool, pub text: Option<String> }

// Reads the interim text for the overlay. Warns once per recording when the
// layout is not recognised, so a changed Claude UI is visible in the log.
fn live_text(session: &mut Session) -> Option<String> {
    let screen = screen(session).ok()?;
    let text = prompt_text(&screen);
    if text.is_none() {
        session.live_misses += 1;
        if session.live_misses == 4 {
            log::warn!("Claude Code live text: prompt not found on screen, live preview unavailable; screen ends with {}", screen_tail(&screen));
        }
    }
    text
}

// Last visible console text, with blank runs collapsed, for diagnostics.
fn screen_tail(screen: &[u16]) -> String {
    let text = String::from_utf16_lossy(screen);
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = flat.chars().count();
    format!("«{}»", flat.chars().skip(count.saturating_sub(160)).collect::<String>())
}

// The last non-empty rows of the screen, one line, rows split by « ⏎ ».
fn screen_rows(screen: &[u16]) -> String {
    let text = String::from_utf16_lossy(screen);
    let rows: Vec<String> = text.lines().map(|row| row.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|row| !row.is_empty()).collect();
    format!("«{}»", rows[rows.len().saturating_sub(12)..].join(" ⏎ "))
}

fn ensure(slot: &mut Option<Session>, visible: bool) -> Result<&mut Session, String> {
    let alive = slot.as_mut().is_some_and(|s| s.child.try_wait().ok().flatten().is_none() && unsafe { IsWindow(s.hwnd as HWND) != 0 });
    if !alive {
        if let Some(mut old) = slot.take() { let _ = old.child.kill(); let _ = old.child.wait(); }
        let exe = claude_exe()?;
        let version = exe_version(&exe).unwrap_or_else(|| "?".into());
        let version = if version == CHECKED_VERSION { version } else {
            log::warn!("Claude Code {version}: dictation was checked with {CHECKED_VERSION}, it may misread this version's screen");
            format!("{version}, проверена {CHECKED_VERSION}")
        };
        // The hidden dictation console is useless without a claude.ai sign-in.
        // The visible one is how the user signs in, so it is always allowed.
        if !visible { check_auth(&exe)?; }
        let base = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Не найден LOCALAPPDATA")?).join("speech-to-text/claude-dictation");
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let dir = base.join(format!("session-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()));
        std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("LICENSE"), include_str!("../claude-dictate-LICENSE")).map_err(|e| e.to_string())?;
        // An HTTP hook avoids starting Git Bash and PowerShell for every prompt
        // (about half a second before the transcript arrives).
        let hook = start_hook_server(dir.clone())?;
        // Only this session: no telemetry, error reports or auto-updates. Sign-in
        // and voice transcription are essential traffic and keep working.
        let settings = serde_json::json!({"language":"ru", "tui":"default", "voice":{"enabled":true,"mode":"tap"},
            "env":{"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"},
            "disableAllHooks":false,"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"http","url":hook,"onFailure":"block"}]}]}});
        std::fs::write(dir.join("settings.json"), settings.to_string()).map_err(|e| e.to_string())?;
        let conhost = PathBuf::from(std::env::var_os("SystemRoot").ok_or("Не найден Windows")?).join("System32/conhost.exe");
        let target = unsafe { GetForegroundWindow() };
        let job = ProcessJob::create()?;
        // ShellExecute starts conhost without inheriting redirected app/test handles,
        // matching AutoHotkey Run. Starting the CLI directly is essential here.
        let parameters = wide(&format!("\"{}\" --settings \"{}\"", exe.display(), dir.join("settings.json").display()));
        let executable = wide(&conhost.to_string_lossy()); let directory = wide(&base.to_string_lossy());
        let mut info: windows_sys::Win32::UI::Shell::SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of_val(&info) as u32;
        info.fMask = windows_sys::Win32::UI::Shell::SEE_MASK_NOCLOSEPROCESS | windows_sys::Win32::UI::Shell::SEE_MASK_NOASYNC;
        info.lpFile = executable.as_ptr(); info.lpParameters = parameters.as_ptr(); info.lpDirectory = directory.as_ptr(); info.nShow = SW_SHOWNOACTIVATE;
        if unsafe { windows_sys::Win32::UI::Shell::ShellExecuteExW(&mut info) } == 0 { return Err(failure("Не удалось запустить консоль Claude Code")); }
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
        let Some((pid, hwnd)) = found else { let status = child.try_wait().ok().flatten(); let _ = child.kill(); child.wait(); return Err(format!("Не найдена классическая консоль Claude Code (код завершения: {status:?}).")); };
        // Under CPU load Claude opened its microphone up to ~0.9 s after Space
        // instead of ~0.1 s. Above-normal priority keeps it responsive; it only
        // matters while it works, idle it takes no CPU.
        unsafe {
            use windows_sys::Win32::System::Threading::{OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION};
            let process = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
            if process.is_null() || SetPriorityClass(process, ABOVE_NORMAL_PRIORITY_CLASS) == 0 {
                log::warn!("Claude Code: {}", failure("не удалось повысить приоритет"));
            }
            if !process.is_null() { CloseHandle(process); }
        }
        unsafe { ShowWindow(hwnd as HWND, if visible { SW_SHOW } else { SW_HIDE }); if !visible && !target.is_null() { SetForegroundWindow(target); } }
        let mut session = Session { child, _job: job, pid, hwnd, dir, owner: None, mic_seen: false, touched: Instant::now(), live_misses: 0, version };
        watch_console(hwnd);
        let mut changes = ConsoleWait::new(hwnd);
        log::info!("Claude Code console started: version {}", session.version);
        // Ready means Claude has drawn its prompt. The visible console is where the
        // user signs in, so it has no prompt yet and is not waited for. The limit
        // only guards against a hung Claude; readiness itself is the screen.
        let ready_deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = session.child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!("Claude Code завершился при запуске: {status}"));
            }
            if visible { break; }
            if unsafe { IsWindow(session.hwnd as HWND) } == 0 {
                let _ = session.child.kill(); session.child.wait();
                return Err("Окно Claude Code закрылось при запуске.".into());
            }
            let current = screen(&session).ok();
            if current.as_deref().and_then(prompt_text).is_some() { break; }
            if Instant::now() > ready_deadline {
                let tail = current.as_deref().map(screen_tail).unwrap_or_default();
                let _ = session.child.kill(); session.child.wait();
                return Err(format!("Claude Code ({}) не показал строку ввода. Откройте его окно в настройках шага и завершите вход или первоначальную настройку. Экран: {tail}", session.version));
            }
            changes.next(SAFETY_CHECK, || false);
        }
        *slot = Some(session);
    }
    let session = slot.as_mut().unwrap();
    if visible { unsafe { ShowWindow(session.hwnd as HWND, SW_RESTORE); SetForegroundWindow(session.hwnd as HWND); } }
    Ok(session)
}

// `claude auth status` reports the sign-in without starting a session (~0.4 s).
fn check_auth(exe: &std::path::Path) -> Result<(), String> {
    use std::{io::Read, os::windows::process::CommandExt, process::Stdio};
    // Normally ~0.4 s; without a limit a hung check held the console lock forever.
    const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
    let begun = Instant::now();
    let mut child = std::process::Command::new(exe).args(["auth", "status"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|e| format!("Не удалось проверить вход в Claude Code: {e}"))?;
    // The answer is a short JSON line, far below the pipe buffer, so waiting
    // before reading cannot block the child on a full pipe.
    let exit = loop {
        if let Some(exit) = child.try_wait().map_err(|e| format!("Не удалось проверить вход в Claude Code: {e}"))? { break exit; }
        if begun.elapsed() > AUTH_TIMEOUT {
            let _ = child.kill(); let _ = child.wait();
            log::warn!("Claude Code auth: `claude auth status` did not answer within {} s", AUTH_TIMEOUT.as_secs());
            return Err(format!("Claude Code не ответил на проверку входа за {} с. Попробуйте ещё раз или откройте его окно в настройках шага.", AUTH_TIMEOUT.as_secs()));
        }
        sleep(Duration::from_millis(50));
    };
    let mut stdout = Vec::new();
    if let Some(mut pipe) = child.stdout.take() { let _ = pipe.read_to_end(&mut stdout); }
    let status: serde_json::Value = serde_json::from_slice(&stdout).unwrap_or_default();
    let method = status.get("authMethod").and_then(|value| value.as_str()).unwrap_or("none");
    let logged_in = exit.success() && status.get("loggedIn").and_then(|value| value.as_bool()) == Some(true);
    log::info!("Claude Code auth: logged in={logged_in}, method={method}, checked in {} ms", begun.elapsed().as_millis());
    if !logged_in {
        return Err("Войдите в Claude Code: нажмите «Открыть Claude Code» в настройках шага и выполните /login.".into());
    }
    if method != "claude.ai" {
        return Err(format!("Диктовка Claude Code работает только со входом через claude.ai (сейчас: {method}). Выполните /login в окне Claude Code."));
    }
    Ok(())
}

// Keeps the dictation console ready while some scenario uses Claude Code, so
// the first recording does not wait for its start, and closes it otherwise.
pub fn prepare(enabled: bool) -> Result<(), String> {
    if enabled {
        ensure(&mut *lock(MAIN)?, false)?;
        // The spare console only speeds up back-to-back recordings; start it
        // without delaying the main one. A failure is reported on its first use.
        std::thread::spawn(|| {
            for index in (0..CONSOLES).filter(|&index| index != MAIN) {
                if let Ok(mut slot) = lock(index) {
                    if let Err(error) = ensure(&mut slot, false) { log::warn!("Claude Code: spare console {index} not started: {error}"); }
                }
            }
        });
        return Ok(());
    }
    for index in 0..CONSOLES {
        let mut slot = lock(index)?;
        if slot.as_ref().is_some_and(|session| session.owner.is_none()) {
            if let Some(mut session) = slot.take() {
                log::info!("Claude Code: no scenario uses it, closing dictation console {index}");
                let _ = session.child.kill(); session.child.wait();
            }
        }
    }
    Ok(())
}

pub fn open(visible: bool) -> Result<(), String> { ensure(&mut *lock(MAIN)?, visible).map(|_| ()) }
pub fn running() -> Result<bool, String> {
    for index in 0..CONSOLES {
        if lock(index)?.as_ref().is_some_and(|s| unsafe { IsWindow(s.hwnd as HWND) != 0 }) { return Ok(true); }
    }
    Ok(false)
}

// Whether the console is held by another live run. A run that ended without stop
// or cancel (overlay reload, error mid-stop) must not lock it forever: the owner
// polls every 250 ms while recording, and stop() keeps touching it.
fn busy(s: &Session, run_id: &str) -> bool {
    let Some(owner) = s.owner.as_deref() else { return false };
    let registered = super::super::scenario_output::RUNS.lock().map(|runs| runs.contains_key(owner)).unwrap_or(false);
    owner != run_id && registered && s.touched.elapsed() < Duration::from_secs(3)
}

pub fn start(run_id: &str) -> Result<(), String> {
    // A flag left by a cancel of this run that came before this start.
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
    // A free running console first, then one still to start; the main one first.
    let mut chosen = None;
    'search: for pass in 0..2 {
        for index in 0..CONSOLES {
            let slot = lock(index)?;
            if slot.as_ref().map_or(pass == 1, |s| !busy(s, run_id)) { chosen = Some((index, slot)); break 'search; }
        }
    }
    let Some((index, mut slot)) = chosen else { return Err("Claude Code уже занят диктовкой.".into()) };
    let waited = requested.elapsed();
    let launched = slot.is_none();
    log::info!("Claude Code start: console {index} taken after {} ms, launching={launched}", waited.as_millis());
    // A console that is starting is not interrupted: it is ready for the next recording.
    let s = ensure(&mut slot, false)?;
    if launched { log::info!("Claude Code start: console {index} ready after {} ms", (requested.elapsed() - waited).as_millis()); }
    if let Some(owner) = s.owner.clone() {
        log::warn!("Claude Code: releasing stale dictation of run {owner} on console {index} (idle {} ms)", s.touched.elapsed().as_millis());
        let _ = key(s, 0x1b, 0x1b, 0);
        s.owner = None;
    }
    if cancelled() {
        log::info!("Claude Code start cancelled before the prompt was cleared");
        return Err(CANCELLED.into());
    }
    let begun = Instant::now();
    let stale = std::fs::remove_file(s.dir.join("transcript.txt")).is_ok();
    log::info!("Claude Code start on console {index}: stale transcript removed={stale}");
    clear_prompt_unless(s, cancelled)?;
    let cleared = begun.elapsed();
    if cancelled() {
        log::info!("Claude Code start cancelled after the prompt was cleared");
        return Err(CANCELLED.into());
    }
    key(s, 0x20, 0x20, 0)?;
    log::info!("Claude Code start: Space sent, waiting for the microphone");
    s.owner = Some(run_id.to_owned()); s.mic_seen = false; s.touched = Instant::now(); s.live_misses = 0;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if cancelled() {
            log::info!("Claude Code start cancelled while waiting for the microphone");
            let _ = key(s, 0x1b, 0x1b, 0); s.owner = None;
            return Err(CANCELLED.into());
        }
        if microphone_active(s.pid).unwrap_or(false) {
            s.mic_seen = true;
            log::info!("Claude Code recording started: prompt cleared in {} ms, microphone opened {} ms after Space", cleared.as_millis(), (begun.elapsed() - cleared).as_millis());
            return Ok(());
        }
        sleep(Duration::from_millis(40));
    }
    log::warn!("Claude Code start: microphone did not open within 5 s");
    let _ = key(s, 0x1b, 0x1b, 0); s.owner = None;
    unsafe { ShowWindow(s.hwnd as HWND, SW_RESTORE); }
    Err(format!("Claude Code ({}) не включил микрофон. Откройте его окно в настройках шага и завершите вход или первоначальную настройку.", s.version))
}

// Answers when the recording ended by itself (transcript or microphone off) or,
// with `live`, when the interim text differs from `known`, the text the overlay
// shows; otherwise after the safety check. The overlay asks again at once, so
// the interim text reaches it as soon as Claude draws it.
pub fn finished(run_id: &str, live: bool, known: Option<&str>) -> Result<Poll, String> {
    let index = owned_by(run_id)?;
    let (hwnd, transcript) = lock(index)?.as_ref().map(|s| (s.hwnd, s.dir.join("transcript.txt"))).ok_or("Сеанс Claude Code закрыт")?;
    let mut changes = ConsoleWait::new(hwnd);
    let deadline = Instant::now() + SAFETY_CHECK;
    let mut next_microphone = Instant::now();
    loop {
        {
            let mut slot = lock(index)?;
            let s = slot.as_mut().ok_or("Сеанс Claude Code закрыт")?;
            if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
            s.touched = Instant::now();
            if unsafe { IsWindow(s.hwnd as HWND) } == 0 { return Err("Окно Claude Code закрыто".into()); }
            if transcript.is_file() { return Ok(Poll { finished: true, text: None }); }
            // The audio-session check is slower than a screen read and Claude only
            // switches the microphone off itself after long silence.
            if Instant::now() >= next_microphone {
                next_microphone = Instant::now() + Duration::from_millis(250);
                if s.mic_seen && !microphone_active(s.pid)? { return Ok(Poll { finished: true, text: None }); }
            }
            let text = if live { live_text(s) } else { None };
            if text.is_some() && text.as_deref() != known || Instant::now() >= deadline { return Ok(Poll { finished: false, text }); }
        }
        let wake = deadline.min(next_microphone).saturating_duration_since(Instant::now());
        changes.next(wake, || transcript.is_file());
    }
}

// `tail` is what is left of the step's after-stop time: Claude keeps listening
// that long after the stop press. The checks run inside it, so Space goes out
// right at its end instead of after them.
pub fn stop(run_id: &str, tail: Duration, first_word: Duration) -> Result<String, String> {
    let deadline = Instant::now() + tail;
    let first_word_deadline = Instant::now() + first_word;
    let index = owned_by(run_id)?;
    let (pid, hwnd) = {
        let slot = lock(index)?;
        let s = slot.as_ref().ok_or("Сеанс Claude Code закрыт")?;
        if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
        (s.pid, s.hwnd)
    };
    let mut changes = ConsoleWait::new(hwnd);
    // Checked as late as possible: Claude may switch the microphone off itself, and
    // Space then would start a new recording. The check takes a few ms.
    sleep(deadline.saturating_duration_since(Instant::now()).saturating_sub(Duration::from_millis(25)));
    let mut mic = microphone_active(pid)?;
    sleep(deadline.saturating_duration_since(Instant::now()));
    // Console Claude keeps only what its server has already recognised: stopped
    // before the first word, it discards the recording even with speech in it.
    // So with no word on screen yet, wait for one before Space. 0 turns the wait off.
    if mic && !first_word.is_zero() {
        let mut waited = false;
        loop {
            let mut slot = lock(index)?;
            let s = slot.as_mut().ok_or("Сеанс Claude Code закрыт")?;
            if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
            s.touched = Instant::now();
            if s.dir.join("transcript.txt").exists() { break; }
            // An unknown layout (no prompt found) is not waited on.
            let empty = screen(s).ok().as_deref().and_then(prompt_text).is_some_and(|text| text.is_empty());
            if !empty {
                if waited { log::info!("Claude Code: first word appeared {} ms after the stop deadline", deadline.elapsed().as_millis()); }
                break;
            }
            if Instant::now() >= first_word_deadline {
                if microphone_active(s.pid).unwrap_or(false) { let _ = key(s, 0x20, 0x20, 0); }
                log::info!("Claude Code: no word {} ms after stop, no speech", first_word.as_millis());
                s.owner = None;
                return Err("Речь не распознана.".into());
            }
            waited = true;
            drop(slot);
            changes.next(SAFETY_CHECK.min(first_word_deadline.saturating_duration_since(Instant::now())), || false);
        }
        // Claude may have switched the microphone off itself meanwhile, and Space
        // then would start a new recording.
        if waited { mic = microphone_active(pid)?; }
    }
    {
        let slot = lock(index)?;
        let s = slot.as_ref().ok_or("Сеанс Claude Code закрыт")?;
        if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
        let ready = s.dir.join("transcript.txt").exists();
        if !ready && mic { key(s, 0x20, 0x20, 0)?; }
        log::info!("Claude Code stop: microphone active={mic}, transcript already present={ready}");
    }
    let transcript = lock(index)?.as_ref().map(|s| s.dir.join("transcript.txt")).ok_or("Сеанс Claude Code закрыт")?;
    let started = Instant::now();
    // After the mic stops Claude finalizes the transcript on its server and, in
    // tap mode, submits it by itself when it has 3+ words (autoSubmit applies to
    // hold mode only). An Enter of ours before the final text would lose the last
    // words, so a short transcript, which Claude does not submit, gets our Enter
    // only once Claude has finished processing it.
    let mut logged_screen: Option<Vec<u16>> = None;
    let mut submitted_screen: Option<Vec<u16>> = None;
    let mut fallback_sent = false;
    let mut seen_processing = false;
    let mut had_text = false;
    loop {
        {
            let mut slot = lock(index)?;
            let s = slot.as_mut().ok_or("Сеанс Claude Code закрыт")?;
            if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
            s.touched = Instant::now();
            let path = s.dir.join("transcript.txt");
            if path.is_file() {
                let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(path);
                s.owner = None;
                log::info!("Claude Code transcript received after {} ms ({}): {}", started.elapsed().as_millis(),
                    if submitted_screen.is_some() || fallback_sent { "our Enter" } else { "submitted by Claude" },
                    super::super::clipboard_history::preview(&text));
                // The blocking hook restores the submitted prompt after exiting.
                // Clear it in the background, once it is back, instead of delaying
                // the transcript. A new recording clears it itself.
                let hwnd = s.hwnd;
                std::thread::spawn(move || {
                    let mut changes = ConsoleWait::new(hwnd);
                    let deadline = Instant::now() + Duration::from_millis(1500);
                    loop {
                        let Ok(slot) = lock(index) else { return };
                        let Some(s) = slot.as_ref().filter(|s| s.owner.is_none()) else { return };
                        let restored = screen(s).ok().as_deref().and_then(prompt_text).is_some_and(|text| !text.is_empty());
                        if restored || Instant::now() >= deadline { let _ = clear_prompt(s); return; }
                        drop(slot);
                        changes.next(SAFETY_CHECK.min(deadline.saturating_duration_since(Instant::now())), || false);
                    }
                });
                if text.trim().is_empty() { return Err("Речь не распознана.".into()); }
                return Ok(text.trim().to_owned());
            }
            // Diagnostics: every screen change after the stop, with the prompt
            // text colours, to see what Claude shows while it finalizes the phrase.
            let seen = screen(s).ok();
            if let Some(current) = seen.as_ref().filter(|current| logged_screen.as_ref() != Some(*current)) {
                log::info!("Claude Code screen +{} ms: {} colours {}", started.elapsed().as_millis(), screen_rows(current), prompt_colours(s, current));
                logged_screen = Some(current.clone());
            }
            // Claude shows «Voice: processing…» while it finalizes the phrase; once
            // it is gone (and the recording too) the prompt text is final, so a
            // short phrase is submitted at once.
            if let Some(current) = seen.as_ref() {
                let footer = String::from_utf16_lossy(current);
                let prompt = prompt_text(current);
                if prompt.as_deref().is_some_and(|text| !text.is_empty()) { had_text = true; }
                if footer.contains("Voice: processing") { seen_processing = true; }
                // Processing ended and the prompt never showed a word: Claude
                // recognised nothing. A prompt that had text and is empty now was
                // submitted by Claude itself, and its hook is on the way.
                else if seen_processing && !had_text && !footer.contains("REC ·") && prompt.as_deref() == Some("") {
                    log::info!("Claude Code: processing ended {} ms after stop with no words, no speech", started.elapsed().as_millis());
                    s.owner = None;
                    return Err("Речь не распознана.".into());
                }
                else if seen_processing && !footer.contains("REC ·") && submitted_screen.is_none() && !fallback_sent
                    && prompt_text(current).is_some_and(|text| !text.is_empty() && text.split_whitespace().count() < 3) {
                    log::info!("Claude Code short prompt final after {} ms (processing ended), submitting", started.elapsed().as_millis());
                    key(s, 0x0d, 0x0d, 0)?;
                    submitted_screen = Some(current.clone());
                }
            }
            if !fallback_sent && submitted_screen.is_none() && started.elapsed() > Duration::from_secs(6) {
                log::warn!("Claude Code prompt did not settle in 6 s, sending fallback Enter");
                key(s, 0x0d, 0x0d, 0)?; fallback_sent = true;
            }
            if started.elapsed() > Duration::from_secs(15) {
                log::warn!("Claude Code returned no transcript in 15 s; screen ends with {}", logged_screen.as_deref().map(screen_tail).unwrap_or_default());
                let _ = key(s, 0x1b, 0x1b, 0); s.owner = None; return Err(format!("Claude Code ({}) не вернул текст. Проверьте окно диктовки.", s.version)); }
        }
        // Screen changes and the hook's transcript wake this wait; the safety
        // check also covers the 6 s and 15 s limits.
        changes.next(SAFETY_CHECK, || transcript.is_file());
    }
}

// Without a run id: every console that has a dictation.
pub fn cancel(run_id: Option<&str>) -> Result<(), String> {
    // First the flag, without waiting: a startup in progress sees it at its next check.
    match run_id {
        Some(run_id) => if let Ok(mut runs) = CANCELLED_RUNS.lock() { runs.push(run_id.to_owned()); },
        None => { CANCEL_ALL.fetch_add(1, Ordering::SeqCst); }
    }
    // Waits for the console lock: a startup holding it has seen the flag by
    // then, or has finished and its dictation is stopped here.
    let result = (|| {
        let mut result = Ok(());
        for index in 0..CONSOLES {
            let mut slot = lock(index)?;
            let Some(s) = slot.as_mut() else { continue };
            if run_id.map_or(s.owner.is_none(), |run_id| s.owner.as_deref() != Some(run_id)) { continue; }
            log::info!("Claude Code: dictation cancelled on console {index}");
            if let Err(error) = key(s, 0x1b, 0x1b, 0) { result = Err(error); }
            s.owner = None;
            let _ = std::fs::remove_file(s.dir.join("transcript.txt"));
        }
        result
    })();
    if let Some(run_id) = run_id { forget_cancel(run_id); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(lines: &[&str]) -> Vec<u16> { lines.join("
").encode_utf16().collect() }

    #[test]
    fn prompt_text_reads_the_dictated_input() {
        let rule = "────────────────";
        let screen = rows(&[" ▐▛███▛█   Claude Code", rule, "❯ Итак, начинаем подготовку. Сейчас▇", rule, "  ⏵⏵ auto mode on   ● REC · tap to send"]);
        assert_eq!(prompt_text(&screen).as_deref(), Some("Итак, начинаем подготовку. Сейчас"));
        let empty = rows(&[rule, "❯ ▃", rule]);
        assert_eq!(prompt_text(&empty).as_deref(), Some(""));
    }

    #[test]
    fn prompt_text_joins_wrapped_rows_and_rejects_unknown_layouts() {
        let rule = "────────";
        let wrapped = rows(&[rule, "❯ первая часть длинной", "  фразы продолжается█", rule]);
        assert_eq!(prompt_text(&wrapped).as_deref(), Some("первая часть длинной фразы продолжается"));
        // The release app gets the ASCII marker.
        assert_eq!(prompt_text(&rows(&[rule, "> текст без юникода▃", rule])).as_deref(), Some("текст без юникода"));
        assert_eq!(prompt_text(&rows(&["другой интерфейс", rule])), None);
        assert_eq!(prompt_text(&rows(&["❯ без нижней линии"])), None);
    }

    #[test]
    #[ignore = "requires installed Claude Code and microphone access"]
    fn native_dictation_smoke() {
        let result = start("native-smoke-test");
        let _ = cancel(Some("native-smoke-test"));
        // Close only the console created by this test process.
        if let Ok(mut slot) = lock(MAIN) {
            if let Some(mut session) = slot.take() {
                unsafe { PostMessageW(session.hwnd as HWND, WM_CLOSE, 0, 0); }
                let _ = session.child.wait();
            }
        }
        assert!(result.is_ok(), "{}", result.err().unwrap_or_default());
    }

    #[test]
    #[ignore = "requires an authenticated Claude Code installation"]
    fn native_hook_smoke() {
        let expected = "dictation integration check";
        {
            let mut slot = lock(MAIN).unwrap();
            let s = ensure(&mut slot, false).unwrap();
            s.owner = Some("hook-smoke".into());
            let _ = std::fs::remove_file(s.dir.join("transcript.txt"));
            key(s, 0x55, 0x15, LEFT_CTRL_PRESSED).unwrap();
            sleep(Duration::from_millis(300));
            for character in expected.encode_utf16() { key(s, 0, character, 0).unwrap(); sleep(Duration::from_millis(30)); }
            sleep(Duration::from_millis(300));
            key(s, 0x0d, 0x0d, 0).unwrap();
        }
        let result = stop("hook-smoke", Duration::ZERO, Duration::ZERO);
        let _ = cancel(Some("hook-smoke"));
        if let Ok(mut slot) = lock(MAIN) {
            if let Some(mut s) = slot.take() { unsafe { PostMessageW(s.hwnd as HWND, WM_CLOSE, 0, 0); } s.child.wait(); }
        }
        assert_eq!(result.unwrap(), expected);
    }
}
