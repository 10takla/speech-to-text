use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig, StreamInstant};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use std::io::Cursor;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::collections::VecDeque;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Failure deadline only: successful completion is determined by capture timestamps.
const CAPTURE_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

struct AudioChunk {
    samples: Vec<f32>,
    captured_at: StreamInstant,
}

struct CaptureSession {
    stream: Stream,
    chunks: Vec<AudioChunk>,
    channels: u16,
    sample_rate: u32,
    paused: bool,
    accept_from: Option<StreamInstant>,
    error: Option<String>,
}

impl CaptureSession {
    fn append(&mut self, chunk: AudioChunk) {
        if self.paused { return; }
        append_chunk(&mut self.chunks, chunk, self.accept_from, self.channels, self.sample_rate);
    }

    fn wav(&self) -> Result<Vec<u8>, String> {
        if let Some(error) = &self.error { return Err(error.clone()); }
        let samples: Vec<f32> = self.chunks.iter().flat_map(|chunk| chunk.samples.iter().copied()).collect();
        samples_to_wav(&samples, self.channels, self.sample_rate)
    }
}

#[derive(Clone)]
pub struct AudioCaptureState {
    sender: Sender<AudioCommand>,
    input_level: Arc<AtomicU32>,
    // When a recording's owner last used it (level meter, snapshots, controls).
    // A capture nobody touches was abandoned, e.g. by an overlay reload, and must
    // not block every later recording with "already recording".
    accessed: Arc<Mutex<Instant>>,
}

// Owners poll the level many times a second while recording; this is far longer.
const ABANDONED_AFTER: Duration = Duration::from_secs(10);

enum AudioCommand {
    Samples(AudioChunk),
    Failed(String),
    // The flag: the running capture looks abandoned and may be replaced.
    Start(Option<String>, bool, Sender<Result<(), String>>),
    Pause(Instant, Sender<Result<(), String>>),
    Snapshot(Sender<Result<Vec<u8>, String>>),
    Resume(Sender<Result<(), String>>),
    Stop(Instant, Sender<Result<Vec<u8>, String>>),
    Cancel,
}

impl AudioCaptureState {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let input_level = Arc::new(AtomicU32::new(0.0f32.to_bits()));
        let worker_level = Arc::clone(&input_level);
        let capture_sender = sender.clone();
        thread::Builder::new()
            .name("microphone-capture".into())
            .spawn(move || audio_worker(receiver, worker_level, capture_sender))
            .expect("failed to start microphone capture worker");
        Self { sender, input_level, accessed: Arc::new(Mutex::new(Instant::now())) }
    }

    fn touch(&self) -> Duration {
        let mut accessed = self.accessed.lock().unwrap_or_else(|error| error.into_inner());
        let idle = accessed.elapsed();
        *accessed = Instant::now();
        idle
    }

    pub fn start(&self, device_id: Option<String>) -> Result<(), String> {
        self.set_input_level(0.0);
        let abandoned = self.touch() >= ABANDONED_AFTER;
        let (reply, response) = mpsc::channel();
        self.sender
            .send(AudioCommand::Start(device_id, abandoned, reply))
            .map_err(|e| e.to_string())?;
        response.recv().map_err(|e| e.to_string())?
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        self.touch();
        let (reply, response) = mpsc::channel();
        self.sender.send(AudioCommand::Snapshot(reply)).map_err(|e| e.to_string())?;
        response.recv().map_err(|e| e.to_string())?
    }

    pub fn pause(&self) -> Result<(), String> {
        self.touch();
        let requested_at = Instant::now();
        let (reply, response) = mpsc::channel();
        self.sender.send(AudioCommand::Pause(requested_at, reply)).map_err(|e| e.to_string())?;
        let result = response.recv().map_err(|e| e.to_string())?;
        self.set_input_level(0.0);
        result
    }

    pub fn resume(&self) -> Result<(), String> {
        self.touch();
        let (reply, response) = mpsc::channel();
        self.sender.send(AudioCommand::Resume(reply)).map_err(|e| e.to_string())?;
        response.recv().map_err(|e| e.to_string())?
    }

    pub fn stop(&self, requested_at: Instant) -> Result<Vec<u8>, String> {
        self.touch();
        let (reply, response) = mpsc::channel();
        self.sender
            .send(AudioCommand::Stop(requested_at, reply))
            .map_err(|e| e.to_string())?;
        let result = response.recv().map_err(|e| e.to_string())?;
        self.set_input_level(0.0);
        result
    }

    pub fn input_level(&self) -> f32 {
        self.touch();
        f32::from_bits(self.input_level.load(Ordering::Relaxed))
    }

    fn set_input_level(&self, level: f32) {
        self.input_level.store(level.to_bits(), Ordering::Relaxed);
    }

    pub fn cancel(&self) {
        self.set_input_level(0.0);
        let _ = self.sender.send(AudioCommand::Cancel);
    }
}

// Map the WebView event time once, on IPC arrival. The subsequent queue and audio
// synchronization use monotonic clocks, so IPC/worker delays do not extend the recording.
pub fn recording_request_instant(requested_at_ms: Option<f64>) -> Result<Instant, String> {
    let now = Instant::now();
    let Some(requested_at_ms) = requested_at_ms else { return Ok(now); };
    if !requested_at_ms.is_finite() || requested_at_ms < 0.0 {
        return Err("Некорректное время остановки записи.".into());
    }
    let unix_now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?;
    let age_ms = (unix_now.as_secs_f64() * 1000.0 - requested_at_ms).max(0.0);
    // Reject stale requests rather than silently trimming to an unrelated recording.
    if age_ms > 60_000.0 { return Err("Запрос остановки записи устарел.".into()); }
    now.checked_sub(Duration::from_secs_f64(age_ms / 1000.0))
        .ok_or_else(|| "Не удалось определить время остановки записи.".into())
}

fn audio_worker(
    receiver: Receiver<AudioCommand>,
    input_level: Arc<AtomicU32>,
    capture_sender: Sender<AudioCommand>,
) {
    let mut active: Option<CaptureSession> = None;
    let mut pending = VecDeque::new();

    while let Ok(command) = pending.pop_front().map(Ok).unwrap_or_else(|| receiver.recv()) {
        match command {
            AudioCommand::Samples(samples) => {
                if let Some(session) = active.as_mut() {
                    session.append(samples);
                }
            }
            AudioCommand::Failed(error) => {
                log::error!("Ошибка входного аудиопотока: {error}");
                if let Some(session) = active.as_mut() { session.error = Some(error); }
            }
            AudioCommand::Start(device_id, abandoned, reply) => {
                // A paused recording legitimately sits idle; only a running one is reclaimed.
                if abandoned && active.as_ref().is_some_and(|session| !session.paused) {
                    log::warn!("Захват микрофона брошен прежним запуском; запись прекращена и начата заново");
                    active.take();
                    discard_audio_chunks(&receiver, &mut pending);
                }
                if active.is_some() {
                    let _ = reply.send(Err("Запись уже выполняется.".into()));
                    continue;
                }
                match create_input_stream(Arc::clone(&input_level), capture_sender.clone(), device_id.as_deref()) {
                    Ok(session) => {
                        active = Some(session);
                        let _ = reply.send(Ok(()));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            AudioCommand::Snapshot(reply) => {
                let result = match active.as_ref() {
                    Some(session) => session.wav(),
                    None => Err("Запись не запущена.".into()),
                };
                let _ = reply.send(result);
            }
            AudioCommand::Pause(requested_at, reply) => {
                let result = match active.as_mut() {
                    Some(session) => finish_capture_boundary(session, requested_at, &receiver, &mut pending)
                        .and_then(|()| session.stream.pause().map_err(|e| e.to_string()))
                        .map(|()| session.paused = true),
                    None => Err("Запись не запущена.".into()),
                };
                let _ = reply.send(result);
            }
            AudioCommand::Resume(reply) => {
                let result = match active.as_mut() {
                    Some(session) => {
                        session.accept_from = Some(session.stream.now());
                        session.stream.play().map_err(|e| e.to_string()).map(|()| session.paused = false)
                    }
                    None => Err("Запись не запущена.".into()),
                };
                let _ = reply.send(result);
            }
            AudioCommand::Stop(requested_at, reply) => {
                let result = match active.take() {
                    Some(mut session) => {
                        let result = finish_capture_boundary(&mut session, requested_at, &receiver, &mut pending)
                            .and_then(|()| session.wav());
                        drop(session);
                        discard_audio_chunks(&receiver, &mut pending);
                        result
                    }
                    None => Err("Запись не запущена.".into()),
                };
                input_level.store(0.0f32.to_bits(), Ordering::Relaxed);
                let _ = reply.send(result);
            }
            AudioCommand::Cancel => {
                input_level.store(0.0f32.to_bits(), Ordering::Relaxed);
                active.take();
                discard_audio_chunks(&receiver, &mut pending);
            }
        }
    }
}

fn frame_duration(frames: usize, sample_rate: u32) -> Duration {
    Duration::from_secs_f64(frames as f64 / f64::from(sample_rate))
}

fn frames_before(chunk: &AudioChunk, boundary: StreamInstant, channels: u16, sample_rate: u32) -> usize {
    let total = chunk.samples.len() / usize::from(channels);
    // Include the frame containing the boundary; never cut its interleaved channels apart.
    let nanos = boundary.duration_since(chunk.captured_at).as_nanos();
    ((nanos * u128::from(sample_rate)).div_ceil(1_000_000_000)).min(total as u128) as usize
}

fn trim_at(chunks: &mut Vec<AudioChunk>, boundary: StreamInstant, channels: u16, sample_rate: u32) {
    for chunk in chunks.iter_mut() {
        let frames = frames_before(chunk, boundary, channels, sample_rate);
        chunk.samples.truncate(frames * usize::from(channels));
    }
    chunks.retain(|chunk| !chunk.samples.is_empty());
}

fn append_chunk(
    chunks: &mut Vec<AudioChunk>, mut chunk: AudioChunk, accept_from: Option<StreamInstant>,
    channels: u16, sample_rate: u32,
) {
    if let Some(start) = accept_from {
        let frames = frames_before(&chunk, start, channels, sample_rate);
        chunk.samples.drain(..frames * usize::from(channels));
        chunk.captured_at = chunk.captured_at + frame_duration(frames, sample_rate);
    }
    if !chunk.samples.is_empty() { chunks.push(chunk); }
}

fn finish_capture_boundary(
    session: &mut CaptureSession,
    requested_at: Instant,
    receiver: &Receiver<AudioCommand>,
    pending: &mut VecDeque<AudioCommand>,
) -> Result<(), String> {
    if let Some(error) = &session.error { return Err(error.clone()); }
    if session.paused { return Ok(()); }
    // Account for time spent in the worker queue. Both instants below advance on
    // monotonic clocks; CPAL's now() and capture timestamps share one time base.
    let now = Instant::now();
    let stream_now = session.stream.now();
    let boundary = capture_boundary_at(stream_now, now, requested_at)
        .ok_or_else(|| "Не удалось определить время остановки аудиопотока.".to_string())?;
    let result = collect_until_boundary(
        &mut session.chunks, session.channels, session.sample_rate, boundary, session.accept_from,
        receiver, pending, requested_at.max(now) + CAPTURE_DRAIN_TIMEOUT,
    );
    if let Err(error) = &result { session.error = Some(error.clone()); }
    result
}

fn capture_boundary_at(stream_now: StreamInstant, now: Instant, requested_at: Instant) -> Option<StreamInstant> {
    if requested_at >= now { stream_now.checked_add(requested_at.duration_since(now)) }
    else { stream_now.checked_sub(now.duration_since(requested_at)) }
}

fn collect_until_boundary(
    chunks: &mut Vec<AudioChunk>,
    channels: u16,
    sample_rate: u32,
    boundary: StreamInstant,
    accept_from: Option<StreamInstant>,
    receiver: &Receiver<AudioCommand>,
    pending: &mut VecDeque<AudioCommand>,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        let received_through = chunks.last().map(|chunk|
            chunk.captured_at + frame_duration(chunk.samples.len() / usize::from(channels), sample_rate));
        if received_through.is_some_and(|end| end >= boundary) {
            trim_at(chunks, boundary, channels, sample_rate);
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(remaining) {
            Ok(AudioCommand::Samples(chunk)) => append_chunk(chunks, chunk, accept_from, channels, sample_rate),
            Ok(AudioCommand::Failed(error)) => return Err(error),
            Ok(AudioCommand::Cancel) => {
                pending.push_front(AudioCommand::Cancel);
                return Err("Запись отменена.".into());
            }
            Ok(other) => pending.push_back(other),
            Err(_) => return Err("Микрофон не передал последние аудиоданные. Запись не удалось завершить полностью.".into()),
        }
    }
}

fn discard_audio_chunks(
    receiver: &Receiver<AudioCommand>,
    pending: &mut VecDeque<AudioCommand>,
) {
    while let Ok(command) = receiver.try_recv() {
        match command {
            AudioCommand::Samples(_) | AudioCommand::Failed(_) => {},
            other => pending.push_back(other),
        }
    }
}

#[derive(serde::Serialize)]
pub struct Microphone {
    id: String,
    name: String,
    error: Option<String>,
}

pub fn list_microphones() -> Result<Vec<Microphone>, String> {
    let host = cpal::default_host();
    let default = host.default_input_device();
    let mut microphones = vec![Microphone {
        id: String::new(),
        name: "Системный микрофон".into(),
        error: match default {
            Some(device) => device.default_input_config().err().map(|e| e.to_string()),
            None => Some("Микрофон не найден".into()),
        },
    }];
    for device in host.input_devices().map_err(|e| e.to_string())? {
        let name = device.description().map_err(|e| e.to_string())?.name().to_string();
        microphones.push(Microphone {
            id: name.clone(), name,
            error: device.default_input_config().err().map(|e| e.to_string()),
        });
    }
    Ok(microphones)
}

fn find_input_device(device_id: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(id) = device_id.filter(|id| !id.is_empty()) {
        return host.input_devices().map_err(|e| e.to_string())?
            .find(|device| device.description().ok().is_some_and(|description| description.name() == id))
            .ok_or_else(|| "Выбранный микрофон не найден. Подключите его или выберите другой.".into());
    }
    host.default_input_device().ok_or_else(|| "Микрофон не найден. Подключите устройство и повторите попытку.".into())
}

pub fn check_microphone(device_id: Option<&str>) -> Result<(), String> {
    let (sender, _receiver) = mpsc::channel();
    let session = create_input_stream(Arc::new(AtomicU32::new(0)), sender, device_id)?;
    drop(session);
    Ok(())
}

fn create_input_stream(
    input_level: Arc<AtomicU32>,
    capture_sender: Sender<AudioCommand>,
    device_id: Option<&str>,
) -> Result<CaptureSession, String> {
    let device = find_input_device(device_id)?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Не удалось открыть микрофон: {e}"))?;
    let channels = supported.channels();
    let sample_rate = supported.sample_rate();
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, config, input_level, capture_sender),
        SampleFormat::F64 => build_stream::<f64>(&device, config, input_level, capture_sender),
        SampleFormat::I8 => build_stream::<i8>(&device, config, input_level, capture_sender),
        SampleFormat::I16 => build_stream::<i16>(&device, config, input_level, capture_sender),
        SampleFormat::I24 => build_stream::<cpal::I24>(&device, config, input_level, capture_sender),
        SampleFormat::I32 => build_stream::<i32>(&device, config, input_level, capture_sender),
        SampleFormat::I64 => build_stream::<i64>(&device, config, input_level, capture_sender),
        SampleFormat::U8 => build_stream::<u8>(&device, config, input_level, capture_sender),
        SampleFormat::U16 => build_stream::<u16>(&device, config, input_level, capture_sender),
        SampleFormat::U32 => build_stream::<u32>(&device, config, input_level, capture_sender),
        SampleFormat::U64 => build_stream::<u64>(&device, config, input_level, capture_sender),
        other => return Err(format!("Формат микрофона не поддерживается: {other:?}")),
    }
    .map_err(|e| format!("Не удалось начать запись с микрофона: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Не удалось включить микрофон: {e}"))?;
    Ok(CaptureSession { stream, chunks: Vec::new(), channels, sample_rate,
        paused: false, accept_from: None, error: None })
}

fn build_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    input_level: Arc<AtomicU32>,
    capture_sender: Sender<AudioCommand>,
) -> Result<Stream, cpal::Error>
where T: cpal::SizedSample, f32: cpal::FromSample<T> {
    let error_sender = capture_sender.clone();
    device.build_input_stream(config,
        move |input: &[T], info: &cpal::InputCallbackInfo| {
            let samples: Vec<f32> = input.iter().map(|&value| value.to_sample::<f32>()).collect();
            let mean_square = samples.iter().map(|sample| sample * sample).sum::<f32>()
                / samples.len().max(1) as f32;
            input_level.store(mean_square.sqrt().to_bits(), Ordering::Relaxed);
            let _ = capture_sender.send(AudioCommand::Samples(AudioChunk {
                samples, captured_at: info.timestamp().capture,
            }));
        },
        move |error| report_stream_error(error, &error_sender),
        None,
    )
}

fn report_stream_error(error: cpal::Error, sender: &Sender<AudioCommand>) {
    // WASAPI keeps delivering packets after a discontinuity (including one at
    // startup/resume). It is not a stream shutdown and must not poison the WAV.
    if error.kind() == cpal::ErrorKind::Xrun {
        log::warn!("Микрофон сообщил о разрыве аудиобуфера; получение аудио продолжается: {error}");
        return;
    }
    let _ = sender.send(AudioCommand::Failed(error.to_string()));
}

fn samples_to_wav(
    samples: &[f32],
    channels: u16,
    sample_rate: u32,
) -> Result<Vec<u8>, String> {
    if samples.is_empty() {
        return Err("Микрофон не передал аудиоданные. Проверьте устройство ввода.".into());
    }

    let ch = channels.max(1) as usize;
    let spec = WavSpec {
        channels: 1, // Моно-дорожка: корректное время и скорость воспроизведения
        sample_rate,
        bits_per_sample: 16,
        sample_format: WavSampleFormat::Int,
    };

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| e.to_string())?;
        // Усредняем чередующиеся каналы (interleaved frames) в один моно-сэмпл
        for frame in samples.chunks(ch) {
            let sum: f32 = frame.iter().copied().sum();
            let mono_sample = sum / frame.len() as f32;
            let clamped = mono_sample.clamp(-1.0, 1.0);
            let pcm = if clamped < 0.0 {
                (clamped * 32768.0) as i16
            } else {
                (clamped * 32767.0) as i16
            };
            writer.write_sample(pcm).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_ms(ms: u64) -> StreamInstant { StreamInstant::from_nanos(ms * 1_000_000) }

    fn chunk(ms: u64, samples: &[f32]) -> AudioChunk {
        AudioChunk { captured_at: at_ms(ms), samples: samples.to_vec() }
    }

    #[test]
    fn buffer_discontinuity_does_not_fail_recording_or_discard_following_audio() {
        let (sender, receiver) = mpsc::channel();
        report_stream_error(cpal::ErrorKind::Xrun.into(), &sender);
        sender.send(AudioCommand::Samples(chunk(10, &[0.3, 0.4, 0.5, 0.6]))).unwrap();
        let mut chunks = vec![chunk(0, &[0.1; 10])];
        collect_until_boundary(&mut chunks, 1, 1000, at_ms(12), None,
            &receiver, &mut VecDeque::new(), Instant::now() + Duration::from_secs(1)).unwrap();
        assert_eq!(chunks[1].samples, vec![0.3, 0.4]);
    }

    #[test]
    fn disconnected_device_still_fails_instead_of_returning_truncated_audio() {
        let (sender, receiver) = mpsc::channel();
        report_stream_error(cpal::ErrorKind::DeviceNotAvailable.into(), &sender);
        let result = collect_until_boundary(&mut Vec::new(), 1, 1000, at_ms(12), None,
            &receiver, &mut VecDeque::new(), Instant::now() + Duration::from_secs(1));
        assert!(result.is_err());
    }

    #[test]
    fn waits_for_delayed_packet_and_preserves_tail_before_stop() {
        let (sender, receiver) = mpsc::channel();
        let producer = thread::spawn(move || {
            sender.send(AudioCommand::Samples(chunk(10, &[0.3, 0.4, 0.5, 0.6]))).unwrap();
        });
        let mut chunks = vec![chunk(0, &[0.1; 10])];
        collect_until_boundary(&mut chunks, 1, 1000, at_ms(13), None,
            &receiver, &mut VecDeque::new(), Instant::now() + Duration::from_secs(1)).unwrap();
        producer.join().unwrap();
        assert_eq!(chunks[1].samples, vec![0.3, 0.4, 0.5]);
    }

    #[test]
    fn trims_already_received_audio_and_keeps_stereo_frames_intact() {
        let (_sender, receiver) = mpsc::channel();
        let mut chunks = vec![chunk(0, &[0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), chunk(3, &[0.7, 0.8])];
        collect_until_boundary(&mut chunks, 2, 1000, at_ms(2), None,
            &receiver, &mut VecDeque::new(), Instant::now()).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].samples, vec![0.1, 0.2, 0.3, 0.4]);
    }

    #[test]
    fn draining_after_resume_excludes_late_packets_from_pause() {
        let (sender, receiver) = mpsc::channel();
        sender.send(AudioCommand::Samples(chunk(10, &[0.9; 4]))).unwrap();
        sender.send(AudioCommand::Samples(chunk(20, &[0.3, 0.4, 0.5, 0.6]))).unwrap();
        let mut chunks = vec![chunk(0, &[0.1; 10])];
        collect_until_boundary(&mut chunks, 1, 1000, at_ms(22), Some(at_ms(20)),
            &receiver, &mut VecDeque::new(), Instant::now() + Duration::from_secs(1)).unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[1].samples, vec![0.3, 0.4]);
    }

    #[test]
    fn missing_tail_returns_error_at_deadline() {
        let (_sender, receiver) = mpsc::channel();
        let result = collect_until_boundary(&mut vec![chunk(0, &[0.1; 10])], 1, 1000,
            at_ms(12), None, &receiver, &mut VecDeque::new(), Instant::now());
        assert!(result.unwrap_err().contains("последние аудиоданные"));
    }

    #[test]
    fn cancellation_interrupts_drain_and_preserves_control_command() {
        let (sender, receiver) = mpsc::channel();
        sender.send(AudioCommand::Cancel).unwrap();
        let mut pending = VecDeque::new();
        let result = collect_until_boundary(&mut Vec::new(), 1, 1000, at_ms(12), None,
            &receiver, &mut pending, Instant::now() + Duration::from_secs(1));
        assert!(result.is_err());
        assert!(matches!(pending.pop_front(), Some(AudioCommand::Cancel)));
    }

    #[test]
    fn ipc_event_time_is_preserved_when_command_arrives_late() {
        let requested_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0 - 250.0;
        let requested = recording_request_instant(Some(requested_ms)).unwrap();
        assert!((240..=300).contains(&requested.elapsed().as_millis()));
        assert!(recording_request_instant(Some(f64::NAN)).is_err());
    }

    #[test]
    fn stop_tail_moves_boundary_into_future_and_preserves_original_time_after_queue_delay() {
        let clicked = Instant::now();
        let target = clicked + Duration::from_millis(150);
        assert_eq!(capture_boundary_at(at_ms(1000), clicked, target), Some(at_ms(1150)));
        // A delayed command still ends at click + 150 ms, not delivery + 150 ms.
        assert_eq!(capture_boundary_at(at_ms(1300), clicked + Duration::from_millis(300), target), Some(at_ms(1150)));
        assert_eq!(capture_boundary_at(at_ms(1000), clicked, clicked), Some(at_ms(1000)));
    }

    #[test]
    fn writes_interleaved_stereo_as_mono_at_the_original_sample_rate() {
        let samples = vec![1.0, -1.0, 0.5, 0.5];
        let wav = samples_to_wav(&samples, 2, 48_000).expect("valid WAV should be produced");
        let mut reader = hound::WavReader::new(std::io::Cursor::new(wav)).expect("valid WAV header");

        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, 48_000);
        let decoded: Vec<i16> = reader.samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(decoded, vec![0, 16_383]);
    }

    #[test]
    fn rejects_empty_captures() {
        let samples = Vec::new();
        assert!(samples_to_wav(&samples, 1, 16_000).is_err());
    }
}
