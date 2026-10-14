use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use std::io::Cursor;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::collections::VecDeque;
use std::thread;

#[derive(Clone)]
pub struct AudioCaptureState {
    sender: Sender<AudioCommand>,
    input_level: Arc<AtomicU32>,
}

enum AudioCommand {
    Samples(Vec<f32>),
    Start(Option<String>, Sender<Result<(), String>>),
    Pause(Sender<Result<(), String>>),
    Snapshot(Sender<Result<Vec<u8>, String>>),
    Resume(Sender<Result<(), String>>),
    Stop(Sender<Result<Vec<u8>, String>>),
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
        Self { sender, input_level }
    }

    pub fn start(&self, device_id: Option<String>) -> Result<(), String> {
        self.set_input_level(0.0);
        let (reply, response) = mpsc::channel();
        self.sender
            .send(AudioCommand::Start(device_id, reply))
            .map_err(|e| e.to_string())?;
        response.recv().map_err(|e| e.to_string())?
    }

    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        let (reply, response) = mpsc::channel();
        self.sender.send(AudioCommand::Snapshot(reply)).map_err(|e| e.to_string())?;
        response.recv().map_err(|e| e.to_string())?
    }

    pub fn pause(&self) -> Result<(), String> {
        let (reply, response) = mpsc::channel();
        self.sender.send(AudioCommand::Pause(reply)).map_err(|e| e.to_string())?;
        let result = response.recv().map_err(|e| e.to_string())?;
        self.set_input_level(0.0);
        result
    }

    pub fn resume(&self) -> Result<(), String> {
        let (reply, response) = mpsc::channel();
        self.sender.send(AudioCommand::Resume(reply)).map_err(|e| e.to_string())?;
        response.recv().map_err(|e| e.to_string())?
    }

    pub fn stop(&self) -> Result<Vec<u8>, String> {
        let (reply, response) = mpsc::channel();
        self.sender
            .send(AudioCommand::Stop(reply))
            .map_err(|e| e.to_string())?;
        let result = response.recv().map_err(|e| e.to_string())?;
        self.set_input_level(0.0);
        result
    }

    pub fn input_level(&self) -> f32 {
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

fn audio_worker(
    receiver: Receiver<AudioCommand>,
    input_level: Arc<AtomicU32>,
    capture_sender: Sender<AudioCommand>,
) {
    let mut active: Option<(Stream, Vec<f32>, u16, u32)> = None;
    let mut pending = VecDeque::new();

    while let Ok(command) = pending.pop_front().map(Ok).unwrap_or_else(|| receiver.recv()) {
        match command {
            AudioCommand::Samples(samples) => {
                if let Some((_, recorded, _, _)) = active.as_mut() {
                    recorded.extend(samples);
                }
            }
            AudioCommand::Start(device_id, reply) => {
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
                    Some((_, samples, channels, sample_rate)) =>
                        samples_to_wav(samples, *channels, *sample_rate),
                    None => Err("Запись не запущена.".into()),
                };
                let _ = reply.send(result);
            }
            AudioCommand::Pause(reply) => {
                let result = match active.as_ref() {
                    Some((stream, _, _, _)) => stream.pause().map_err(|e| e.to_string()),
                    None => Err("Запись не запущена.".into()),
                };
                if result.is_ok() {
                    drain_audio_chunks(&receiver, &mut pending, &mut active);
                }
                let _ = reply.send(result);
            }
            AudioCommand::Resume(reply) => {
                let result = match active.as_ref() {
                    Some((stream, _, _, _)) => stream.play().map_err(|e| e.to_string()),
                    None => Err("Запись не запущена.".into()),
                };
                let _ = reply.send(result);
            }
            AudioCommand::Stop(reply) => {
                input_level.store(0.0f32.to_bits(), Ordering::Relaxed);
                let result = match active.take() {
                    Some((stream, mut samples, channels, sample_rate)) => {
                        drop(stream);
                        drain_audio_chunks_into(&receiver, &mut pending, &mut samples);
                        samples_to_wav(&samples, channels, sample_rate)
                    }
                    None => Err("Запись не запущена.".into()),
                };
                let _ = reply.send(result);
            }
            AudioCommand::Cancel => {
                input_level.store(0.0f32.to_bits(), Ordering::Relaxed);
                active.take();
                let mut discarded = Vec::new();
                drain_audio_chunks_into(&receiver, &mut pending, &mut discarded);
            }
        }
    }
}

fn drain_audio_chunks(
    receiver: &Receiver<AudioCommand>,
    pending: &mut VecDeque<AudioCommand>,
    active: &mut Option<(Stream, Vec<f32>, u16, u32)>,
) {
    if let Some((_, samples, _, _)) = active.as_mut() {
        drain_audio_chunks_into(receiver, pending, samples);
    }
}

fn drain_audio_chunks_into(
    receiver: &Receiver<AudioCommand>,
    pending: &mut VecDeque<AudioCommand>,
    samples: &mut Vec<f32>,
) {
    while let Ok(command) = receiver.try_recv() {
        match command {
            AudioCommand::Samples(chunk) => samples.extend(chunk),
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
        let name = device.name().map_err(|e| e.to_string())?;
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
            .find(|device| device.name().ok().as_deref() == Some(id))
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
) -> Result<(Stream, Vec<f32>, u16, u32), String> {
    let device = find_input_device(device_id)?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Не удалось открыть микрофон: {e}"))?;
    let channels = supported.channels();
    let sample_rate = supported.sample_rate().0;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let error_callback = |error| log::error!("Ошибка входного аудиопотока: {error}");

    let stream = match sample_format {
        SampleFormat::F32 => {
            let level = Arc::clone(&input_level);
            let sender = capture_sender.clone();
            device.build_input_stream(
                &config,
                move |input: &[f32], _| {
                    let mean_square = input.iter().map(|&sample| sample * sample).sum::<f32>()
                        / input.len().max(1) as f32;
                    level.store(mean_square.sqrt().to_bits(), Ordering::Relaxed);
                    let _ = sender.send(AudioCommand::Samples(input.to_vec()));
                },
                error_callback,
                None,
            )
        }
        SampleFormat::I16 => {
            let level = Arc::clone(&input_level);
            let sender = capture_sender.clone();
            device.build_input_stream(
                &config,
                move |input: &[i16], _| {
                    let mean_square = input.iter().map(|&sample| {
                        let sample = sample as f32 / 32768.0;
                        sample * sample
                    }).sum::<f32>() / input.len().max(1) as f32;
                    level.store(mean_square.sqrt().to_bits(), Ordering::Relaxed);
                    let samples = input.iter().map(|&v| v as f32 / 32768.0).collect();
                    let _ = sender.send(AudioCommand::Samples(samples));
                },
                error_callback,
                None,
            )
        }
        SampleFormat::U16 => {
            let level = Arc::clone(&input_level);
            let sender = capture_sender.clone();
            device.build_input_stream(
                &config,
                move |input: &[u16], _| {
                    let mean_square = input.iter().map(|&sample| {
                        let sample = (sample as f32 - 32768.0) / 32768.0;
                        sample * sample
                    }).sum::<f32>() / input.len().max(1) as f32;
                    level.store(mean_square.sqrt().to_bits(), Ordering::Relaxed);
                    let samples = input.iter().map(|&v| (v as f32 - 32768.0) / 32768.0).collect();
                    let _ = sender.send(AudioCommand::Samples(samples));
                },
                error_callback,
                None,
            )
        }
        other => return Err(format!("Формат микрофона не поддерживается: {other:?}")),
    }
    .map_err(|e| format!("Не удалось начать запись с микрофона: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Не удалось включить микрофон: {e}"))?;
    Ok((stream, Vec::new(), channels, sample_rate))
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
    use super::samples_to_wav;

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
