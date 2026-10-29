// Генератор звуковых сигналов через Web Audio API без внешних аудиофайлов

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) throw new Error('Web Audio API недоступен.');
    audioCtx = new AudioContextClass();
  }
  return audioCtx;
}

export type SoundEvent = 'start_record' | 'insert_text' | 'cancel' | 'error';

export async function playSound(event: SoundEvent, soundProfile: string = 'default'): Promise<void> {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const ended = new Promise<void>(resolve => osc.addEventListener('ended', () => resolve(), { once: true }));
    osc.connect(gain);
    gain.connect(ctx.destination);

    switch (event) {
      case 'start_record':
        // Мягкий нарастающий сигнал начала записи (440 Гц -> 880 Гц)
        osc.type = soundProfile === 'soft' ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

        osc.start(now);
        osc.stop(now + 0.15);
        break;

      case 'insert_text':
        if (soundProfile === 'click') {
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(880, now);
          gain.gain.setValueAtTime(0.001, now);
          gain.gain.linearRampToValueAtTime(0.12, now + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
          osc.start(now);
          osc.stop(now + 0.07);
        } else {
          // Приятный завершающий аккорд успешной вставки текста (587.33 Гц -> 880 Гц)
          osc.type = 'sine';
          osc.frequency.setValueAtTime(587.33, now);
          osc.frequency.setValueAtTime(880, now + 0.08);

          gain.gain.setValueAtTime(0.001, now);
          gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

          osc.start(now);
          osc.stop(now + 0.22);
        }
        break;

      case 'cancel':
        // Низкий сигнал отмены (330 Гц -> 220 Гц)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(330, now);
        osc.frequency.linearRampToValueAtTime(220, now + 0.12);

        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

        osc.start(now);
        osc.stop(now + 0.15);
        break;

      case 'error':
        // Сигнал ошибки
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.setValueAtTime(180, now + 0.1);

        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

        osc.start(now);
        osc.stop(now + 0.26);
        break;
    }
    await ended;
    osc.disconnect();
    gain.disconnect();
  } catch (err) {
    console.warn('Ошибка воспроизведения звука:', err);
  }
}
