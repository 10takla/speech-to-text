use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, Command},
    sync::{Condvar, Mutex},
    thread::sleep,
    time::{Duration, Instant},
};
use windows_sys::Win32::{Foundation::*, UI::WindowsAndMessaging::*};

struct ProcessJob(isize);
impl Drop for ProcessJob { fn drop(&mut self) { unsafe { CloseHandle(self.0 as HANDLE); } } }
impl ProcessJob {
    fn create() -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return Err(failure("Не удалось создать группу процессов Claude Chat")); }
            let job = Self(handle as isize);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(handle, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0 {
                return Err(failure("Не удалось настроить закрытие Claude Chat"));
            }
            Ok(job)
        }
    }
    fn assign(&self, handle: HANDLE) -> Result<(), String> {
        if unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.0 as HANDLE, handle) } == 0 {
            return Err(failure("Не удалось привязать процесс Claude Chat к приложению"));
        }
        Ok(())
    }
}

struct BridgeState {
    ready: bool,
    started: bool,
    live_text: String,
    final_text: Option<String>,
    error: Option<String>,
    commands: VecDeque<&'static str>,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            ready: false,
            started: false,
            live_text: String::new(),
            final_text: None,
            error: None,
            commands: VecDeque::new(),
        }
    }
}

static BRIDGE: Mutex<Option<BridgeState>> = Mutex::new(None);
static BRIDGE_WAKE: Condvar = Condvar::new();

fn push_command(cmd: &'static str) {
    if let Ok(mut guard) = BRIDGE.lock() {
        let state = guard.get_or_insert_with(BridgeState::default);
        state.commands.push_back(cmd);
        BRIDGE_WAKE.notify_all();
    }
}

const BRIDGE_PORT: u16 = 18765;
const BRIDGE_TOKEN: &str = "claude-chat-bridge";

fn start_bridge_server() -> Result<(u16, String), String> {
    let mut listener = None;
    for _ in 0..5 {
        if let Ok(bound) = TcpListener::bind(("127.0.0.1", BRIDGE_PORT)) {
            listener = Some(bound);
            break;
        }
        sleep(Duration::from_millis(150));
    }
    let listener = match listener {
        Some(bound) => bound,
        None => TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    log::info!("Claude Chat bridge listening on 127.0.0.1:{port}");
    let token = BRIDGE_TOKEN.to_owned();
    let events_path = format!("/{token}/events");
    let state_path = format!("/{token}/state");

    std::thread::Builder::new().name("claude-chat-bridge".into()).spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let events_path = events_path.clone();
            let state_path = state_path.clone();
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() { return; }
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("");
                let path = parts.next().unwrap_or("");
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" || line == "\n" { break; }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.trim().eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap_or(0); }
                    }
                }

                if method == "OPTIONS" {
                    let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 0\r\n\r\n");
                    return;
                }

                if method == "GET" && path == events_path {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nAccess-Control-Allow-Origin: *\r\nConnection: keep-alive\r\n\r\n");
                    let _ = stream.flush();
                    loop {
                        let cmd = {
                            let Ok(mut guard) = BRIDGE.lock() else { return };
                            loop {
                                let state = guard.get_or_insert_with(BridgeState::default);
                                if let Some(cmd) = state.commands.pop_front() { break cmd; }
                                let (next, _) = match BRIDGE_WAKE.wait_timeout(guard, Duration::from_secs(15)) {
                                    Ok(res) => res,
                                    Err(_) => return,
                                };
                                guard = next;
                                if guard.as_ref().is_some_and(|s| s.commands.is_empty()) {
                                    if stream.write_all(b": ping\n\n").is_err() || stream.flush().is_err() { return; }
                                }
                            }
                        };
                        if stream.write_all(format!("data: {cmd}\n\n").as_bytes()).is_err() || stream.flush().is_err() {
                            return;
                        }
                    }
                } else if method == "POST" && path == state_path {
                    let mut body = vec![0; length.min(1024 * 1024)];
                    if reader.read_exact(&mut body).is_ok() {
                        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) {
                            let event = json.get("event").and_then(|v| v.as_str()).unwrap_or("");
                            log::info!("Claude Chat bridge event: {event}");
                            if let Ok(mut guard) = BRIDGE.lock() {
                                let state = guard.get_or_insert_with(BridgeState::default);
                                match event {
                                    "ready" => state.ready = true,
                                    "started" => state.started = true,
                                    "live" => {
                                        if let Some(text) = json.get("text").and_then(|v| v.as_str()) {
                                            state.live_text = text.to_owned();
                                        }
                                    }
                                    "stopped" => {
                                        let text = json.get("text").and_then(|v| v.as_str()).unwrap_or("").to_owned();
                                        state.final_text = Some(text);
                                    }
                                    "debug" => {
                                        if let Some(msg) = json.get("message").and_then(|v| v.as_str()) {
                                            log::info!("Claude Chat debug: {msg}");
                                        }
                                    }
                                    "error" => {
                                        let err = json.get("error").and_then(|v| v.as_str()).unwrap_or("Ошибка Claude Chat").to_owned();
                                        log::warn!("Claude Chat bridge error: {err}");
                                        state.error = Some(err);
                                    }
                                    _ => {}
                                }
                                BRIDGE_WAKE.notify_all();
                            }
                        }
                    }
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                } else {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            });
        }
    }).map_err(|e| e.to_string())?;

    Ok((port, token))
}

struct Session {
    child: Child,
    _job: ProcessJob,
    hwnd: isize,
    owner: Option<String>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static BRIDGE_INFO: Mutex<Option<(u16, String)>> = Mutex::new(None);

fn failure(label: &str) -> String { format!("{label}: {}", std::io::Error::last_os_error()) }

fn edge_exe() -> Result<PathBuf, String> {
    for var in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            let candidate = PathBuf::from(base).join("Microsoft/Edge/Application/msedge.exe");
            if candidate.is_file() { return Ok(candidate); }
        }
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = dir.join("msedge.exe");
        if path.is_file() { return Ok(path); }
    }
    Err("Не найден Microsoft Edge (msedge.exe).".into())
}

unsafe extern "system" fn find_edge_window(hwnd: HWND, pointer: LPARAM) -> i32 {
    let query = unsafe { &mut *(pointer as *mut (u32, isize)) };
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid); }
    if pid != query.0 { return 1; }
    let mut class = [0u16; 64];
    let count = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    let name = String::from_utf16_lossy(&class[..count.max(0) as usize]);
    if name == "Chrome_WidgetWin_1" && unsafe { IsWindowVisible(hwnd) != 0 && GetWindow(hwnd, GW_OWNER).is_null() } {
        query.1 = hwnd as isize;
        return 0;
    }
    1
}

fn prepare_extension_dir(port: u16, token: &str) -> Result<PathBuf, String> {
    let ext_dir = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Не найден LOCALAPPDATA")?)
        .join("speech-to-text")
        .join("claude-web-ext");
    std::fs::create_dir_all(&ext_dir).map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join("manifest.json"), include_str!("extension/manifest.json")).map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join("background.js"), include_str!("extension/background.js")).map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join("content.js"), include_str!("extension/content.js")).map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join("config.js"), format!("const BRIDGE_URL = \"http://127.0.0.1:{port}/{token}\";\n")).map_err(|e| e.to_string())?;
    Ok(ext_dir)
}

fn ensure(visible: bool) -> Result<(), String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    let alive = slot.as_mut().is_some_and(|s| s.child.try_wait().ok().flatten().is_none() && unsafe { IsWindow(s.hwnd as HWND) != 0 });
    if !alive {
        if let Some(mut old) = slot.take() { let _ = old.child.kill(); let _ = old.child.wait(); }
        let (port, token) = {
            let mut info = BRIDGE_INFO.lock().map_err(|e| e.to_string())?;
            if info.is_none() { *info = Some(start_bridge_server()?); }
            info.clone().unwrap()
        };
        let ext_dir = prepare_extension_dir(port, &token)?;
        let exe = edge_exe()?;
        let profile = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Не найден LOCALAPPDATA")?)
            .join("speech-to-text")
            .join("claude-web");
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        let job = ProcessJob::create()?;
        let child = Command::new(&exe)
            .args([
                &format!("--user-data-dir={}", profile.display()),
                &format!("--load-extension={}", ext_dir.display()),
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-sync",
                "--mute-audio",
                "https://claude.ai/new",
            ])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Не удалось запустить Microsoft Edge: {e}"))?;

        use std::os::windows::io::AsRawHandle;
        let _ = job.assign(child.as_raw_handle() as HANDLE);

        let pid = child.id();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut hwnd = 0isize;
        while Instant::now() < deadline {
            let mut query = (pid, 0isize);
            unsafe { EnumWindows(Some(find_edge_window), &mut query as *mut _ as isize); }
            if query.1 != 0 { hwnd = query.1; break; }
            sleep(Duration::from_millis(80));
        }
        if !visible && hwnd != 0 {
            unsafe { ShowWindow(hwnd as HWND, SW_HIDE); }
        }
        log::info!("Claude Chat Edge started (pid={pid}, hwnd={hwnd})");
        *slot = Some(Session { child, _job: job, hwnd, owner: None });
    }
    if visible {
        if let Some(s) = slot.as_ref() {
            if s.hwnd != 0 {
                unsafe {
                    ShowWindow(s.hwnd as HWND, SW_RESTORE);
                    SetForegroundWindow(s.hwnd as HWND);
                }
            }
        }
    }
    Ok(())
}

pub fn open(visible: bool) -> Result<(), String> { ensure(visible) }

pub fn prepare(enabled: bool) -> Result<(), String> {
    if enabled { return ensure(false); }
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = slot.take() {
        log::info!("Claude Chat: closing background Edge");
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

pub fn running() -> Result<bool, String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    Ok(slot.as_mut().is_some_and(|s| s.child.try_wait().ok().flatten().is_none()))
}

pub struct Poll { pub finished: bool, pub text: Option<String> }

pub fn start(run_id: &str) -> Result<(), String> {
    ensure(false)?;
    {
        let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
        let s = slot.as_mut().ok_or("Сеанс Claude Chat не запущен")?;
        s.owner = Some(run_id.to_owned());
    }
    {
        let mut guard = BRIDGE.lock().map_err(|e| e.to_string())?;
        let state = guard.get_or_insert_with(BridgeState::default);
        state.started = false;
        state.live_text.clear();
        state.final_text = None;
        state.error = None;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    {
        let mut guard = BRIDGE.lock().map_err(|e| e.to_string())?;
        while !guard.as_ref().is_some_and(|s| s.ready) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("Расширение Claude Chat не подключилось. Откройте Claude Chat в настройках шага и проверьте страницу.".into());
            }
            guard = BRIDGE_WAKE.wait_timeout(guard, left).map_err(|e| e.to_string())?.0;
        }
    }
    push_command("start");
    let start_deadline = Instant::now() + Duration::from_secs(5);
    let mut guard = BRIDGE.lock().map_err(|e| e.to_string())?;
    loop {
        if let Some(state) = guard.as_ref() {
            if let Some(err) = &state.error { return Err(err.clone()); }
            if state.started { return Ok(()); }
        }
        let left = start_deadline.saturating_duration_since(Instant::now());
        if left.is_zero() { return Err("Claude Chat не запустил голосовой ввод.".into()); }
        guard = BRIDGE_WAKE.wait_timeout(guard, left).map_err(|e| e.to_string())?.0;
    }
}

pub fn finished(run_id: &str, live: bool, known: Option<&str>) -> Result<Poll, String> {
    {
        let slot = SESSION.lock().map_err(|e| e.to_string())?;
        if slot.as_ref().and_then(|s| s.owner.as_deref()) != Some(run_id) {
            return Err("Диктовка отменена".into());
        }
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut guard = BRIDGE.lock().map_err(|e| e.to_string())?;
    loop {
        if let Some(state) = guard.as_ref() {
            if let Some(err) = &state.error { return Err(err.clone()); }
            if state.final_text.is_some() { return Ok(Poll { finished: true, text: None }); }
            if live && !state.live_text.is_empty() && Some(state.live_text.as_str()) != known {
                return Ok(Poll { finished: false, text: Some(state.live_text.clone()) });
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() { return Ok(Poll { finished: false, text: None }); }
        guard = BRIDGE_WAKE.wait_timeout(guard, left).map_err(|e| e.to_string())?.0;
    }
}

pub fn stop(run_id: &str, tail: Duration, _first_word: Duration) -> Result<String, String> {
    if !tail.is_zero() { sleep(tail); }
    {
        let slot = SESSION.lock().map_err(|e| e.to_string())?;
        if slot.as_ref().and_then(|s| s.owner.as_deref()) != Some(run_id) {
            return Err("Диктовка отменена".into());
        }
    }
    push_command("stop");
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut guard = BRIDGE.lock().map_err(|e| e.to_string())?;
    loop {
        if let Some(state) = guard.as_mut() {
            if let Some(err) = state.error.take() { return Err(err); }
            if let Some(text) = state.final_text.take() {
                if let Ok(mut slot) = SESSION.lock() {
                    if let Some(s) = slot.as_mut() { s.owner = None; }
                }
                if text.trim().is_empty() { return Err("Речь не распознана.".into()); }
                return Ok(text.trim().to_owned());
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            if let Ok(mut slot) = SESSION.lock() {
                if let Some(s) = slot.as_mut() { s.owner = None; }
            }
            return Err("Claude Chat не вернул текст за 15 с.".into());
        }
        guard = BRIDGE_WAKE.wait_timeout(guard, left).map_err(|e| e.to_string())?.0;
    }
}

pub fn cancel(run_id: Option<&str>) -> Result<(), String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(s) = slot.as_mut() {
        if run_id.is_none() || s.owner.as_deref() == run_id {
            s.owner = None;
            push_command("cancel");
        }
    }
    Ok(())
}
