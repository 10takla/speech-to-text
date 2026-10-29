use std::{path::PathBuf, sync::Mutex, thread::sleep, time::{Duration, Instant}};
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
    live_misses: u32 }
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
// AttachConsole is process-wide. Never use it concurrently with another transport.
static CONSOLE: Mutex<()> = Mutex::new(());
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
fn failure(label: &str) -> String { format!("{label}: {}", std::io::Error::last_os_error()) }

fn claude_exe() -> Result<PathBuf, String> {
    let local = PathBuf::from(std::env::var_os("USERPROFILE").ok_or("Не найден профиль Windows")?).join(".local/bin/claude.exe");
    if local.is_file() { return Ok(local); }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = dir.join("claude.exe"); if path.is_file() { return Ok(path); }
    }
    Err("Не найден claude.exe. Установите Claude Code.".into())
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

fn microphone_active(pid: u32) -> Result<bool, String> {
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
        let result = if AttachConsole(session.pid) == 0 {
            Err(failure("Не удалось подключиться к консоли Claude Code"))
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
                    if std::fs::write(&temporary, text).is_ok() { let _ = std::fs::rename(&temporary, dir.join("transcript.txt")); }
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

// The prompt text Claude shows while dictating. Claude has no API for the
// interim transcript, so this reads its rendering, relying only on the `❯`
// prompt marker and the `────` rule below the (possibly wrapped) input.
// None means the layout was not recognised (e.g. after a Claude update).
fn prompt_text(screen: &[u16]) -> Option<String> {
    let text = String::from_utf16_lossy(screen);
    let rows: Vec<&str> = text.lines().collect();
    let start = rows.iter().rposition(|row| row.trim_start().starts_with('❯'))?;
    let mut parts = vec![rows[start].trim_start().trim_start_matches('❯')];
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
fn clear_prompt(session: &Session) -> Result<(), String> {
    for attempt in 0..40 {
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
        sleep(Duration::from_millis(40));
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

fn ensure(slot: &mut Option<Session>, visible: bool) -> Result<&mut Session, String> {
    let alive = slot.as_mut().is_some_and(|s| s.child.try_wait().ok().flatten().is_none() && unsafe { IsWindow(s.hwnd as HWND) != 0 });
    if !alive {
        if let Some(mut old) = slot.take() { let _ = old.child.kill(); let _ = old.child.wait(); }
        let exe = claude_exe()?;
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
        unsafe { ShowWindow(hwnd as HWND, if visible { SW_SHOW } else { SW_HIDE }); if !visible && !target.is_null() { SetForegroundWindow(target); } }
        sleep(Duration::from_secs(5));
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("Claude Code завершился при запуске: {status}"));
        }
        *slot = Some(Session { child, _job: job, pid, hwnd, dir, owner: None, mic_seen: false, touched: Instant::now(), live_misses: 0 });
    }
    let session = slot.as_mut().unwrap();
    if visible { unsafe { ShowWindow(session.hwnd as HWND, SW_RESTORE); SetForegroundWindow(session.hwnd as HWND); } }
    Ok(session)
}

// `claude auth status` reports the sign-in without starting a session (~0.4 s).
fn check_auth(exe: &std::path::Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new(exe).args(["auth", "status"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output().map_err(|e| format!("Не удалось проверить вход в Claude Code: {e}"))?;
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    let method = status.get("authMethod").and_then(|value| value.as_str()).unwrap_or("none");
    let logged_in = output.status.success() && status.get("loggedIn").and_then(|value| value.as_bool()) == Some(true);
    log::info!("Claude Code auth: logged in={logged_in}, method={method}");
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
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    if enabled { return ensure(&mut slot, false).map(|_| ()); }
    if slot.as_ref().is_some_and(|session| session.owner.is_none()) {
        if let Some(mut session) = slot.take() {
            log::info!("Claude Code: no scenario uses it, closing the dictation console");
            let _ = session.child.kill(); session.child.wait();
        }
    }
    Ok(())
}

pub fn open(visible: bool) -> Result<(), String> { let mut slot = SESSION.lock().map_err(|e| e.to_string())?; ensure(&mut slot, visible).map(|_| ()) }
pub fn running() -> Result<bool, String> { Ok(SESSION.lock().map_err(|e| e.to_string())?.as_ref().is_some_and(|s| unsafe { IsWindow(s.hwnd as HWND) != 0 })) }

pub fn start(run_id: &str) -> Result<(), String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    let s = ensure(&mut slot, false)?;
    if let Some(owner) = s.owner.clone() {
        // The console is shared by the whole app. A run that ended without stop or
        // cancel (overlay reload, error mid-stop) must not lock it forever: the owner
        // polls every 500 ms while recording, and stop() keeps touching it.
        let registered = super::super::scenario_output::RUNS.lock().map(|runs| runs.contains_key(&owner)).unwrap_or(false);
        let idle = s.touched.elapsed();
        if owner != run_id && registered && idle < Duration::from_secs(3) {
            return Err("Claude Code уже занят диктовкой.".into());
        }
        log::warn!("Claude Code: releasing stale dictation of run {owner} (registered={registered}, idle {} ms)", idle.as_millis());
        let _ = key(s, 0x1b, 0x1b, 0);
        s.owner = None;
    }
    let stale = std::fs::remove_file(s.dir.join("transcript.txt")).is_ok();
    log::info!("Claude Code start: stale transcript removed={stale}; screen ends with {}",
        screen(s).map(|current| screen_tail(&current)).unwrap_or_else(|error| error));
    clear_prompt(s)?;
    key(s, 0x20, 0x20, 0)?;
    s.owner = Some(run_id.to_owned()); s.mic_seen = false; s.touched = Instant::now(); s.live_misses = 0;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if microphone_active(s.pid).unwrap_or(false) { s.mic_seen = true; log::info!("Claude Code recording started"); return Ok(()); }
        sleep(Duration::from_millis(150));
    }
    let _ = key(s, 0x1b, 0x1b, 0); s.owner = None;
    unsafe { ShowWindow(s.hwnd as HWND, SW_RESTORE); }
    Err("Claude Code не включил микрофон. Откройте его окно в настройках шага и завершите вход или первоначальную настройку.".into())
}

pub fn finished(run_id: &str, live: bool) -> Result<Poll, String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    let s = slot.as_mut().ok_or("Сеанс Claude Code закрыт")?;
    if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
    s.touched = Instant::now();
    if unsafe { IsWindow(s.hwnd as HWND) } == 0 { return Err("Окно Claude Code закрыто".into()); }
    let finished = s.dir.join("transcript.txt").is_file() || (s.mic_seen && !microphone_active(s.pid)?);
    Ok(Poll { finished, text: if live { live_text(s) } else { None } })
}

pub fn stop(run_id: &str) -> Result<String, String> {
    {
        let slot = SESSION.lock().map_err(|e| e.to_string())?;
        let s = slot.as_ref().ok_or("Сеанс Claude Code закрыт")?;
        if s.owner.as_deref() != Some(run_id) { return Err("Диктовка отменена".into()); }
        let mic = microphone_active(s.pid)?;
        let ready = s.dir.join("transcript.txt").exists();
        log::info!("Claude Code stop: microphone active={mic}, transcript already present={ready}");
        if !ready && mic { key(s, 0x20, 0x20, 0)?; }
    }
    let started = Instant::now();
    // After the mic stops Claude finalizes the transcript on its server and, in
    // tap mode, submits it by itself when it has 3+ words. The interim text on
    // screen can pause before that, so an Enter of ours would submit the interim
    // text and lose the last words. Only a short transcript, which Claude does not
    // submit, needs our Enter, and only after the screen has stayed still longer.
    let mut last_screen: Option<Vec<u16>> = None;
    let mut stable_since = Instant::now();
    let mut submitted_screen: Option<Vec<u16>> = None;
    let mut fallback_sent = false;
    loop {
        {
            let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
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
                // Clear it in the background instead of delaying the transcript.
                std::thread::spawn(|| {
                    sleep(Duration::from_millis(700));
                    if let Ok(slot) = SESSION.lock() {
                        if let Some(s) = slot.as_ref().filter(|s| s.owner.is_none()) { let _ = clear_prompt(s); }
                    }
                });
                if text.trim().is_empty() { return Err("Речь не распознана.".into()); }
                return Ok(text.trim().to_owned());
            }
            if !microphone_active(s.pid).unwrap_or(false) {
                if let Ok(current) = screen(s) {
                    if last_screen.as_ref() != Some(&current) { last_screen = Some(current); stable_since = Instant::now(); }
                    // Nothing was said (or a quick on/off): the prompt stays empty, no
                    // hook ever fires, and waiting for the 15 s timeout looks like a hang.
                    else if stable_since.elapsed() >= Duration::from_millis(1500) && prompt_text(&current).as_deref() == Some("") {
                        log::info!("Claude Code: prompt still empty {} ms after stop, no speech; screen ends with {}",
                            started.elapsed().as_millis(), screen_tail(&current));
                        s.owner = None;
                        return Err("Речь не распознана.".into());
                    }
                    else if stable_since.elapsed() >= Duration::from_millis(1000) && submitted_screen != last_screen
                        && prompt_text(&current).is_some_and(|text| !text.is_empty() && text.split_whitespace().count() < 3) {
                        log::info!("Claude Code short prompt settled after {} ms, submitting: {}", started.elapsed().as_millis(), screen_tail(&current));
                        key(s, 0x0d, 0x0d, 0)?;
                        submitted_screen = last_screen.clone();
                    }
                }
            }
            if !fallback_sent && submitted_screen.is_none() && started.elapsed() > Duration::from_secs(6) {
                log::warn!("Claude Code prompt did not settle in 6 s, sending fallback Enter");
                key(s, 0x0d, 0x0d, 0)?; fallback_sent = true;
            }
            if started.elapsed() > Duration::from_secs(15) {
                log::warn!("Claude Code returned no transcript in 15 s; screen ends with {}", last_screen.as_deref().map(screen_tail).unwrap_or_default());
                let _ = key(s, 0x1b, 0x1b, 0); s.owner = None; return Err("Claude Code не вернул текст. Проверьте окно диктовки.".into()); }
        }
        sleep(Duration::from_millis(50));
    }
}

pub fn cancel(run_id: Option<&str>) -> Result<(), String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(s) = slot.as_mut() {
        if run_id.is_some() && s.owner.as_deref() != run_id { return Ok(()); }
        let result = key(s, 0x1b, 0x1b, 0);
        s.owner = None;
        let _ = std::fs::remove_file(s.dir.join("transcript.txt"));
        result?;
    }
    Ok(())
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
        assert_eq!(prompt_text(&rows(&["> другой интерфейс", rule])), None);
        assert_eq!(prompt_text(&rows(&["❯ без нижней линии"])), None);
    }

    #[test]
    #[ignore = "requires installed Claude Code and microphone access"]
    fn native_dictation_smoke() {
        let result = start("native-smoke-test");
        let _ = cancel(Some("native-smoke-test"));
        // Close only the console created by this test process.
        if let Ok(mut slot) = SESSION.lock() {
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
            let mut slot = SESSION.lock().unwrap();
            let s = ensure(&mut slot, false).unwrap();
            s.owner = Some("hook-smoke".into());
            let _ = std::fs::remove_file(s.dir.join("transcript.txt"));
            key(s, 0x55, 0x15, LEFT_CTRL_PRESSED).unwrap();
            sleep(Duration::from_millis(300));
            for character in expected.encode_utf16() { key(s, 0, character, 0).unwrap(); sleep(Duration::from_millis(30)); }
            sleep(Duration::from_millis(300));
            key(s, 0x0d, 0x0d, 0).unwrap();
        }
        let result = stop("hook-smoke");
        let _ = cancel(Some("hook-smoke"));
        if let Ok(mut slot) = SESSION.lock() {
            if let Some(mut s) = slot.take() { unsafe { PostMessageW(s.hwnd as HWND, WM_CLOSE, 0, 0); } s.child.wait(); }
        }
        assert_eq!(result.unwrap(), expected);
    }
}
