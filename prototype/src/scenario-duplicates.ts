import { DEFAULT_SCENARIO_STEP_SETTINGS, getScenarioStepContract, normalizeClipboardHistoryLevel,
  type Scenario, type ScenarioStep, type ScenarioStepSettingsDefaults } from './scenario';
import { normalizeSpeechSettings } from './speech-settings';
import { normalizeSpeechProvider, normalizeSpeechProviders } from './speech-provider-settings';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function significantSettings(step: ScenarioStep, defaults: ScenarioStepSettingsDefaults, clipboardHistory: boolean): unknown {
  if (step.type === 'copy') return clipboardHistory ? normalizeClipboardHistoryLevel(step.clipboardHistoryLevel) : null;
  if (step.type === 'paste') return clipboardHistory ? step.returnFocusToOriginalWindow === true : null;
  if (step.type === 'transcribe') {
    const s = step.transcription ?? defaults.transcription;
    if (s.provider === 'gemini') return {
      provider: s.provider, geminiTranscription: s.geminiTranscription ? { ...s.geminiTranscription, apiKey: undefined } : undefined,
      live: s.liveTranscriptionEnabled, final: s.retranscribeFullRecording === true,
      chunks: s.liveTranscriptionEnabled ? [s.liveSilenceDurationMs, s.liveMaxChunkDurationSeconds, s.liveChunkOverlapSeconds] : undefined,
    };
    if (s.provider === 'google-cloud') return {
      provider: s.provider, googleCloud: s.googleCloud ? { ...s.googleCloud, credentials: undefined } : undefined,
      live: s.liveTranscriptionEnabled, final: s.retranscribeFullRecording === true,
      chunks: s.liveTranscriptionEnabled ? [s.liveSilenceDurationMs, s.liveMaxChunkDurationSeconds, s.liveChunkOverlapSeconds] : undefined,
    };
    return s.provider === 'none' ? { provider: s.provider } : {
      provider: s.provider, model: s.model.trim(), language: s.language, prompt: s.prompt.trim(),
      temperature: s.temperature, responseFormat: s.responseFormat, live: s.liveTranscriptionEnabled,
      final: s.retranscribeFullRecording === true,
      chunks: s.liveTranscriptionEnabled ? [s.liveSilenceDurationMs, s.liveMaxChunkDurationSeconds, s.liveChunkOverlapSeconds] : undefined,
    };
  }
  if (step.type === 'postprocess') {
    const s = step.postprocessing ?? defaults.postprocessing;
    return s.provider === 'none' ? { provider: s.provider } : {
      provider: s.provider, model: s.model.trim(), prompt: s.prompt.trim(), generation: s.generationConfig ?? { temperature: .2 },
    };
  }
  const provider = normalizeSpeechProvider(step.speechProvider);
  if (provider === 'none') return { provider };
  if (provider === 'system') return { provider, settings: normalizeSpeechSettings(step.speechSettings) };
  const settings = normalizeSpeechProviders(step.speechProviders);
  if (provider === 'edge') return { provider, settings: settings.edge };
  if (provider === 'piper') return { provider, ...settings.piper, url: settings.piper.url.replace(/\/+$/, '') };
  if (provider === 'gemini') {
    const { apiKey: _key, ...options } = settings.gemini;
    return { provider, ...options };
  }
  const { apiKey: _key, canUseStyle, canUseSpeakerBoost, style, speakerBoost, ...options } = settings.elevenlabs;
  return { provider, ...options, style: canUseStyle ? style : undefined, speakerBoost: canUseSpeakerBoost ? speakerBoost : undefined };
}

export interface DuplicateStep { id: string; title: string; position: number }

/** Compare data lineage, never text equality. All branches share their owner's input. */
export function findScenarioDuplicates(scenario: Scenario, defaults = DEFAULT_SCENARIO_STEP_SETTINGS, clipboardHistory = true): Map<string, DuplicateStep[]> {
  const groups = new Map<string, DuplicateStep[]>();
  let position = 0;
  const walk = (steps: ScenarioStep[], input: string) => {
    for (let index = 0; index < steps.length;) {
      const head = steps[index];
      let end = index + 1;
      if (head.parallelGroup && getScenarioStepContract(head.type).category === 'action') {
        while (end < steps.length && steps[end].parallelGroup === head.parallelGroup
          && getScenarioStepContract(steps[end].type).category === 'action') end++;
      }
      const group = steps.slice(index, end);
      for (const step of group) {
        const item = { id: step.id, title: getScenarioStepContract(step.type).title, position: ++position };
        if (step.enabled && step.type !== 'startRecording') {
          const key = canonical([step.type, input, significantSettings(step, defaults, clipboardHistory)]);
          const matches = groups.get(key) ?? [];
          matches.push(item); groups.set(key, matches);
        }
        for (const branch of step.parallelBranches ?? []) walk(branch, input);
      }
      if (group.length === 1 && head.enabled && getScenarioStepContract(head.type).category !== 'action') input = head.id;
      index = end;
    }
  };
  walk(scenario.steps, 'trigger');
  const duplicates = new Map<string, DuplicateStep[]>();
  for (const matches of groups.values()) if (matches.length > 1) {
    for (const step of matches) duplicates.set(step.id, matches.filter(other => other.id !== step.id));
  }
  return duplicates;
}
