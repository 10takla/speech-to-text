use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, Command},
    sync::{atomic::{AtomicU64, Ordering}, Condvar, Mutex},
    thread::sleep,
    time::{Duration, Instant},
};
use windows_sys::Win32::{Foundation::*, System::Diagnostics::ToolHelp::*, UI::WindowsAndMessaging::*};

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
    active_polls: usize,
    last_poll: Option<Instant>,
    started: bool,
    live_text: String,
    final_text: Option<String>,
    error: Option<String>,
    commands: VecDeque<&'static str>,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            active_polls: 0,
            last_poll: None,
            started: false,
            live_text: String::new(),
            final_text: None,
            error: None,
            commands: VecDeque::new(),
        }
    }
}

impl BridgeState {
    fn is_ready(&self) -> bool {
        self.active_polls > 0 || self.last_poll.is_some_and(|t| t.elapsed() < Duration::from_secs(25))
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

fn start_bridge_server() -> Result<(u16, String), String> {
    use std::hash::{BuildHasher, Hasher};
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    log::info!("Claude Chat bridge listening on 127.0.0.1:{port}");
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    let token = format!("{:016x}{:016x}", hasher.finish(), std::collections::hash_map::RandomState::new().build_hasher().finish());
    let poll_path = format!("/{token}/poll");
    let state_path = format!("/{token}/state");

    std::thread::Builder::new().name("claude-chat-bridge".into()).spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let poll_path = poll_path.clone();
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

                if method == "GET" && path == poll_path {
                    let cmd = {
                        let Ok(mut guard) = BRIDGE.lock() else { return };
                        let state = guard.get_or_insert_with(BridgeState::default);
                        let was_ready = state.is_ready();
                        state.active_polls += 1;
                        state.last_poll = Some(Instant::now());
                        if !was_ready {
                            log::info!("Claude Chat bridge connected (content long-poll active)");
                        }
                        BRIDGE_WAKE.notify_all();
                        let deadline = Instant::now() + Duration::from_secs(20);
                        let cmd = loop {
                            let state = guard.get_or_insert_with(BridgeState::default);
                            if let Some(cmd) = state.commands.pop_front() { break Some(cmd); }
                            let left = deadline.saturating_duration_since(Instant::now());
                            if left.is_zero() { break None; }
                            guard = match BRIDGE_WAKE.wait_timeout(guard, left) {
                                Ok((next, _)) => next,
                                Err(_) => return,
                            };
                        };
                        if let Some(state) = guard.as_mut() {
                            state.active_polls = state.active_polls.saturating_sub(1);
                            state.last_poll = Some(Instant::now());
                        }
                        cmd
                    };
                    let body = match cmd {
                        Some(c) => format!("{{\"cmd\":\"{c}\"}}"),
                        None => "{\"cmd\":null}".to_owned(),
                    };
                    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    if stream.write_all(resp.as_bytes()).is_err() || stream.flush().is_err() {
                        if let Some(c) = cmd {
                            if let Ok(mut guard) = BRIDGE.lock() {
                                if let Some(state) = guard.as_mut() {
                                    state.commands.push_front(c);
                                    BRIDGE_WAKE.notify_all();
                                }
                            }
                        }
                    }
                } else if method == "POST" && path == state_path {
                    let mut body = vec![0; length.min(1024 * 1024)];
                    if reader.read_exact(&mut body).is_ok() {
                        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) {
                            let event = json.get("event").and_then(|v| v.as_str()).unwrap_or("");
                            if event != "debug" && event != "error" {
                                log::info!("Claude Chat bridge event: {event}");
                            }
                            if let Ok(mut guard) = BRIDGE.lock() {
                                let state = guard.get_or_insert_with(BridgeState::default);
                                match event {
                                    "ready" => state.last_poll = Some(Instant::now()),
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
                    static LAST_UNEXPECTED: Mutex<Option<(String, Instant)>> = Mutex::new(None);
                    let key = format!("{method} {path}");
                    let should_log = LAST_UNEXPECTED
                        .lock()
                        .map(|mut slot| {
                            let stale = slot.as_ref().is_none_or(|(prev, at)| prev != &key || at.elapsed() >= Duration::from_secs(10));
                            if stale { *slot = Some((key.clone(), Instant::now())); }
                            stale
                        })
                        .unwrap_or(false);
                    if should_log {
                        log::warn!("Claude Chat bridge unexpected request: {key}");
                    }
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
static CANCELLED_RUNS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static CANCEL_ALL: AtomicU64 = AtomicU64::new(0);
const CANCELLED: &str = "Диктовка отменена";

fn forget_cancel(run_id: &str) {
    if let Ok(mut runs) = CANCELLED_RUNS.lock() { runs.retain(|id| id != run_id); }
}

fn process_family(parent: u32) -> Vec<u32> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE { return vec![parent]; }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut ok = Process32FirstW(snapshot, &mut entry);
        let mut entries = Vec::new();
        while ok != 0 {
            entries.push((entry.th32ProcessID, entry.th32ParentProcessID));
            ok = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        let mut family = vec![parent];
        loop {
            let previous = family.len();
            for (pid, owner) in &entries {
                if family.contains(owner) && !family.contains(pid) { family.push(*pid); }
            }
            if previous == family.len() { break; }
        }
        family
    }
}

fn microphone_active_any(pids: Vec<u32>) -> Result<bool, String> {
    std::thread::spawn(move || microphone_active_here(&pids))
        .join()
        .map_err(|_| "Проверка микрофона Claude Chat прервана".to_string())?
}

fn microphone_active_here(pids: &[u32]) -> Result<bool, String> {
    use windows::{core::Interface, Win32::{Media::Audio::*, System::Com::*}};
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        if initialized.is_err() { return Err("Не удалось проверить микрофон Claude Chat".into()); }
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
                    if pids.contains(&control2.GetProcessId()?) && control.GetState()? == AudioSessionStateActive {
                        return Ok(true);
                    }
                }
            }
            Ok(false)
        })();
        CoUninitialize();
        result.map_err(|error| format!("Проверка микрофона: {error}"))
    }
}

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

fn extension_content_hash(manifest: &str, background: &str, content: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for chunk in [manifest.as_bytes(), b"\0", background.as_bytes(), b"\0", content.as_bytes()] {
        for &b in chunk {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

fn prepare_extension_dir(port: u16, token: &str, profile: &std::path::Path) -> Result<PathBuf, String> {
    let ext_dir = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Не найден LOCALAPPDATA")?)
        .join("speech-to-text")
        .join("claude-web-ext");
    std::fs::create_dir_all(&ext_dir).map_err(|e| e.to_string())?;

    let manifest_tpl = include_str!("extension/manifest.json");
    let background_js = include_str!("extension/background.js");
    let content_js = include_str!("extension/content.js");
    let hash = extension_content_hash(manifest_tpl, background_js, content_js);

    let state_path = ext_dir.join(".ext-version");
    let (prev_seq, prev_hash) = std::fs::read_to_string(&state_path)
        .ok()
        .and_then(|s| {
            let mut parts = s.split_whitespace();
            let seq = parts.next()?.parse::<u32>().ok()?;
            let h = u64::from_str_radix(parts.next()?, 16).ok()?;
            Some((seq, h))
        })
        .unwrap_or((0, 0));
    let expected_sw = format!("bg-{prev_seq}.js");
    let changed = prev_seq == 0 || prev_hash != hash || !ext_dir.join(&expected_sw).is_file();
    let seq = if changed { prev_seq.saturating_add(1) } else { prev_seq };
    let version = format!("1.{}.{}", seq / 65535, seq % 65535);
    let sw_name = format!("bg-{seq}.js");
    let manifest = manifest_tpl
        .replace("\"version\": \"1.0.0\"", &format!("\"version\": \"{version}\""))
        .replace("\"service_worker\": \"background.js\"", &format!("\"service_worker\": \"{sw_name}\""));

    if changed {
        if let Ok(entries) = std::fs::read_dir(&ext_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name == "background.js" || (name.starts_with("bg-") && name.ends_with(".js")) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        let sw_cache = profile.join("Default").join("Service Worker");
        if sw_cache.exists() {
            match std::fs::remove_dir_all(&sw_cache) {
                Ok(()) => log::info!("Claude Chat cleared Edge Service Worker cache: {}", sw_cache.display()),
                Err(e) => log::warn!("Claude Chat failed to clear Service Worker cache {}: {e}", sw_cache.display()),
            }
        }
    }

    std::fs::write(ext_dir.join("manifest.json"), manifest).map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join(&sw_name), background_js).map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join("content.js"), content_js).map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join("config.json"), format!("{{\"bridgeUrl\":\"http://127.0.0.1:{port}/{token}\"}}\n")).map_err(|e| e.to_string())?;
    let _ = std::fs::write(&state_path, format!("{seq} {hash:016x}\n"));
    let _ = std::fs::remove_file(ext_dir.join("config.js"));
    log::info!("Claude Chat extension prepared (version={version}, sw={sw_name}, changed={changed})");
    Ok(ext_dir)
}

fn kill_stale_profile_edge(profile: &std::path::Path) {
    let needle = profile.to_string_lossy().replace('\'', "''");
    let script = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object {{ $_.CommandLine -like '*{needle}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(0x08000000)
        .status();
}

fn is_interesting_edge_log_line(line: &str) -> bool {
    if line.contains("devtools://")
        || line.contains("AddComponentExtension")
        || line.contains("Permissions-Policy header")
        || line.contains("[DatadogRUM]")
        || line.contains("fallback_task_provider.cc")
        || line.contains("external_registry_loader_win.cc")
        || line.contains("extension_garbage_collector.cc")
        || line.contains("ScriptProcessorNode is deprecated")
    {
        return false;
    }
    line.contains("[claude-chat")
        || line.contains("CONSOLE:")
        || line.contains("CONSOLE(")
        || line.contains("extension")
        || line.contains("Extension")
        || line.contains("service_worker")
        || line.contains("ServiceWorker")
        || line.contains("ERROR:")
        || line.contains("FATAL:")
}

fn edge_log_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(|base| PathBuf::from(base).join("speech-to-text").join("claude-web").join("edge.log"))
}

fn log_recent_edge_log_tail() {
    let Some(path) = edge_log_path() else { return; };
    let Ok(mut file) = std::fs::File::open(&path) else {
        log::warn!("Claude Chat Edge log snapshot: cannot open {}", path.display());
        return;
    };
    let mut raw = Vec::new();
    if file.read_to_end(&mut raw).is_err() { return; }
    let text = String::from_utf8_lossy(&raw);
    let matches: Vec<&str> = text.lines().filter(|l| is_interesting_edge_log_line(l)).collect();
    let start = matches.len().saturating_sub(15);
    log::info!("Claude Chat Edge log snapshot ({} matched lines in {}, showing last {}):",
        matches.len(), path.display(), matches.len() - start);
    for line in &matches[start..] {
        log::info!("Claude Chat Edge log (snapshot): {line}");
    }
}

fn start_edge_log_tailer(log_path: PathBuf, stop_epoch: u64) {
    std::thread::Builder::new().name("claude-chat-edge-log".into()).spawn(move || {
        use std::io::{Seek, SeekFrom};
        let mut offset = 0u64;
        loop {
            if EDGE_LOG_EPOCH.load(Ordering::SeqCst) != stop_epoch { return; }
            if let Ok(mut file) = std::fs::File::open(&log_path) {
                let len = file.metadata().map(|m| m.len()).unwrap_or(0);
                if len < offset { offset = 0; }
                if len > offset && file.seek(SeekFrom::Start(offset)).is_ok() {
                    let mut raw = Vec::new();
                    if file.read_to_end(&mut raw).is_ok() && !raw.is_empty() {
                        if let Some(last_nl) = raw.iter().rposition(|&b| b == b'\n') {
                            let complete = &raw[..=last_nl];
                            offset += complete.len() as u64;
                            let text = String::from_utf8_lossy(complete);
                            for line in text.lines() {
                                if is_interesting_edge_log_line(line) {
                                    log::info!("Claude Chat Edge log: {line}");
                                }
                            }
                        }
                    }
                }
            }
            sleep(Duration::from_millis(400));
        }
    }).ok();
}

static EDGE_LOG_EPOCH: AtomicU64 = AtomicU64::new(0);

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
        let exe = edge_exe()?;
        let profile = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Не найден LOCALAPPDATA")?)
            .join("speech-to-text")
            .join("claude-web");
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        // Terminate any orphaned Edge left over from a previous app instance using our isolated profile,
        // so the new Edge starts cleanly with the fresh extension config and does not delegate to a stale process.
        kill_stale_profile_edge(&profile);
        let ext_dir = prepare_extension_dir(port, &token, &profile)?;
        if let Ok(mut guard) = BRIDGE.lock() {
            if let Some(state) = guard.as_mut() {
                state.active_polls = 0;
                state.last_poll = None;
                state.commands.clear();
            }
        }
        let edge_log = profile.join("edge.log");
        let _ = std::fs::remove_file(&edge_log);
        let log_epoch = EDGE_LOG_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
        start_edge_log_tailer(edge_log.clone(), log_epoch);
        log::info!("Claude Chat launching Edge: exe={}, profile={}, ext={}, log={}",
            exe.display(), profile.display(), ext_dir.display(), edge_log.display());
        let job = ProcessJob::create()?;
        let child = Command::new(&exe)
            .args([
                &format!("--user-data-dir={}", profile.display()),
                &format!("--load-extension={}", ext_dir.display()),
                "--enable-logging",
                &format!("--log-file={}", edge_log.display()),
                "--v=0",
                "--vmodule=*service_worker*=1,*extension*=1",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-sync",
                "--mute-audio",
                "--hide-crash-restore-bubble",
                "--disable-session-crashed-bubble",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-features=msEdgeSleepingTabs,IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
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

pub fn hide() -> Result<(), String> {
    let slot = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(s) = slot.as_ref() {
        if s.hwnd != 0 && unsafe { IsWindow(s.hwnd as HWND) != 0 } {
            unsafe { ShowWindow(s.hwnd as HWND, SW_HIDE); }
        }
    }
    Ok(())
}

pub fn visible() -> Result<bool, String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    Ok(slot.as_mut().is_some_and(|s| {
        s.child.try_wait().ok().flatten().is_none()
            && s.hwnd != 0
            && unsafe { IsWindow(s.hwnd as HWND) != 0 && IsWindowVisible(s.hwnd as HWND) != 0 }
    }))
}

pub fn prepare(enabled: bool) -> Result<(), String> {
    if enabled { return ensure(false); }
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = slot.take() {
        log::info!("Claude Chat: closing background Edge");
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let profile = PathBuf::from(local).join("speech-to-text").join("claude-web");
        kill_stale_profile_edge(&profile);
    }
    Ok(())
}

pub fn running() -> Result<bool, String> {
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    Ok(slot.as_mut().is_some_and(|s| s.child.try_wait().ok().flatten().is_none()))
}

pub struct Poll { pub finished: bool, pub text: Option<String> }

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
    let begun = Instant::now();
    ensure(false)?;
    if cancelled() { return Err(CANCELLED.into()); }
    let edge_pid = {
        let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
        let s = slot.as_mut().ok_or("Сеанс Claude Chat не запущен")?;
        s.owner = Some(run_id.to_owned());
        s.child.id()
    };
    {
        let mut guard = BRIDGE.lock().map_err(|e| e.to_string())?;
        let state = guard.get_or_insert_with(BridgeState::default);
        state.started = false;
        state.live_text.clear();
        state.final_text = None;
        state.error = None;
        state.commands.clear();
    }
    log::info!("Claude Chat start(run_id={run_id}): waiting for bridge ready");
    let deadline = Instant::now() + Duration::from_secs(10);
    {
        let mut guard = BRIDGE.lock().map_err(|e| e.to_string())?;
        while !guard.as_ref().is_some_and(|s| s.is_ready()) {
            if cancelled() {
                drop(guard);
                clear_owner(run_id);
                return Err(CANCELLED.into());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                let polls = guard.as_ref().map(|s| s.active_polls).unwrap_or(0);
                let last = guard.as_ref().and_then(|s| s.last_poll).map(|t| t.elapsed().as_millis());
                log::warn!("Claude Chat start timeout: bridge not ready after 10s (active_polls={polls}, last_poll_ms={last:?})");
                drop(guard);
                log_recent_edge_log_tail();
                clear_owner(run_id);
                return Err("Расширение Claude Chat не подключилось. Откройте Claude Chat в настройках шага и проверьте страницу.".into());
            }
            guard = BRIDGE_WAKE.wait_timeout(guard, left.min(Duration::from_millis(100))).map_err(|e| e.to_string())?.0;
        }
    }
    log::info!("Claude Chat start(run_id={run_id}): bridge ready, pushing start command");
    if cancelled() {
        clear_owner(run_id);
        return Err(CANCELLED.into());
    }
    push_command("start");
    let start_deadline = Instant::now() + Duration::from_secs(6);
    {
        let mut guard = BRIDGE.lock().map_err(|e| e.to_string())?;
        loop {
            if cancelled() {
                drop(guard);
                clear_owner(run_id);
                push_command("cancel");
                return Err(CANCELLED.into());
            }
            if let Some(state) = guard.as_ref() {
                if let Some(err) = &state.error {
                    let msg = err.clone();
                    drop(guard);
                    clear_owner(run_id);
                    return Err(msg);
                }
                if state.started { break; }
            }
            let left = start_deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                if let Some(state) = guard.as_mut() { state.commands.clear(); }
                drop(guard);
                log::warn!("Claude Chat start timeout: dictation UI did not start within 6s");
                log_recent_edge_log_tail();
                clear_owner(run_id);
                return Err("Claude Chat не запустил голосовой ввод.".into());
            }
            guard = BRIDGE_WAKE.wait_timeout(guard, left.min(Duration::from_millis(100))).map_err(|e| e.to_string())?.0;
        }
    }
    // Wait until Edge's audio process actually opens the capture stream so the
    // overlay only shows «recording» once Claude Chat is genuinely listening.
    let ui_ready_ms = begun.elapsed().as_millis();
    let mic_deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < mic_deadline {
        if cancelled() {
            clear_owner(run_id);
            push_command("cancel");
            return Err(CANCELLED.into());
        }
        let family = process_family(edge_pid);
        if microphone_active_any(family).unwrap_or(false) {
            log::info!("Claude Chat recording started: UI ready in {ui_ready_ms} ms, mic active at {} ms", begun.elapsed().as_millis());
            return Ok(());
        }
        sleep(Duration::from_millis(30));
    }
    log::warn!("Claude Chat: UI started in {ui_ready_ms} ms, but Edge audio capture session was not observed within 4 s; continuing");
    Ok(())
}

fn clear_owner(run_id: &str) {
    if let Ok(mut slot) = SESSION.lock() {
        if let Some(s) = slot.as_mut() {
            if s.owner.as_deref() == Some(run_id) { s.owner = None; }
        }
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
    {
        let mut guard = BRIDGE.lock().map_err(|e| e.to_string())?;
        let state = guard.get_or_insert_with(BridgeState::default);
        state.final_text = None;
        state.error = None;
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
    match run_id {
        Some(run_id) => if let Ok(mut runs) = CANCELLED_RUNS.lock() { runs.push(run_id.to_owned()); },
        None => { CANCEL_ALL.fetch_add(1, Ordering::SeqCst); }
    }
    BRIDGE_WAKE.notify_all();
    let mut slot = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(s) = slot.as_mut() {
        if run_id.is_none() || s.owner.as_deref() == run_id {
            s.owner = None;
            push_command("cancel");
        }
    }
    Ok(())
}
