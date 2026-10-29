import { useEffect } from 'react';
import './control-panel.scss';
import { observeScenarioProgress } from './scenario-progress';
import { observePanelColumns } from './panel-columns/layout';

export default function ControlPanelApp() {
  useEffect(() => observePanelColumns(document.querySelector<HTMLElement>('.cp-main')!), []);
  useEffect(() => observeScenarioProgress(document.getElementById('scenario-editor')!), []);
  useEffect(() => {
    void import('./control-panel-controller').then(() => {
      document.getElementById('startup-loading')?.remove();
    }).catch((error: unknown) => {
      const message = document.getElementById('startup-loading-message');
      if (message) message.textContent = 'Не удалось загрузить приложение. Перезапустите его.';
      console.error('Не удалось загрузить панель управления:', error);
    });
  }, []);
  
  return (
<div id="control-panel-app">
      <main className="cp-main">
        <div className="cp-workspace-column">
        <div className="cp-column cp-settings-column">
        {/* 1. Конфигурация */}
        <section className="cp-card cp-compact-settings">
          <div className="cp-settings-content compact-actions">
          <h2>Конфигурация</h2>
          <div className="btn-group">
            <button id="btn-reset-settings" className="btn secondary">Сбросить настройки</button>
            <button id="btn-settings-json" className="btn secondary" aria-expanded="false" aria-controls="settings-json-panel">Настройки (JSON)</button>
            <button id="btn-copy-logs" className="btn secondary">Скопировать логи</button>
          </div>
          <div id="settings-json-panel" className="settings-json-panel" hidden>
            <textarea id="input-settings-json" aria-label="Конфигурация JSON" aria-describedby="settings-json-status" spellCheck={false} />
            <div className="btn-group">
              <button id="btn-copy-settings-json" className="btn secondary">Скопировать</button>
              <button id="btn-apply-settings-json" className="btn primary">Применить</button>
              <button id="btn-cancel-settings-json" className="btn secondary">Отмена</button>
            </div>
            <p id="settings-json-status" role="status" aria-live="polite" />
          </div>
          </div>
        </section>

        <section className="cp-card cp-compact-settings" id="startup-settings">
          <div className="cp-settings-content">
          <h2>Запуск приложения</h2>
          <div className="form-field"><label htmlFor="startup-mode">При входе в Windows:</label><select id="startup-mode"><option value="">Не запускать</option><option value="window">Открывать окно</option><option value="hidden-taskbar">Свёрнутым в панели задач</option><option value="tray">Скрытым в трее</option></select></div>
          </div>
        </section>

        {/* 5. Оверлей */}
        <section className="cp-card cp-compact-settings">
          <div className="cp-settings-content">
          <h2>Оверлей</h2>
          <div className="overlay-settings-row">
          <div className="overlay-width-row">
            <label htmlFor="overlay-max-width-percent">Макс. ширина:</label>
            <div className="overlay-width-control">
              <input type="range" id="overlay-max-width-slider" min="0" max="100" step="0.1" aria-label="Максимальная ширина оверлея в процентах от ширины монитора" />
              <input type="number" id="overlay-max-width-percent" min="0" max="100" step="0.1" />
              <span className="unit-label">%</span>
            </div>
          </div>
          <button id="btn-reset-pos" className="btn secondary compact-btn">Сброс позиции</button>
          </div>
          <div className="checkbox-row">
            <label className="checkbox-label" title="Перемещать оверлей на монитор под курсором во время записи">
              <input type="checkbox" id="toggle-overlay-monitor-movement" /> Перемещать оверлей за курсором между мониторами
            </label>
          </div>
          </div>
        </section>

        </div>

        <div className="cp-column cp-scenario-column">
        <section className="cp-card cp-compact-settings cp-scenarios">
          <h2>Сценарии обработки</h2>
          <div id="scenario-editor" />
        </section>

        {/* 3. Настройки провайдера (Описание приложения.md:21-25) */}
        <section className="cp-card">
          <div className="card-header-row">
            <h2>Транскрибация речи</h2>
            <div className="btn-group">
              <span id="stt-provider-status" className="status-pill status-pill--idle">Не настроен</span>
              <button id="check-groq-settings" className="btn secondary compact-btn" type="button" title="Проверить ключ и модель без обработки аудио. Запрос API может учитываться в ограничениях провайдера.">Тест</button>
            </div>
          </div>
          <p id="groq-check-result" className="model-load-status" role="status" aria-live="polite" />
          <div className="form-grid">
            <div className="form-field form-field--important">
              <label htmlFor="provider-select">Провайдер речи: <span className="req-marker" title="Обязательная настройка">*</span></label>
              <select id="provider-select">
                <option value="none">Не выбран</option>
                <option value="groq">Groq (Whisper Cloud API)</option>
                <option value="google-cloud">Google Cloud</option>
                <option value="gemini">Google Gemini (AI Studio)</option>
              </select>
            </div>
            <div className="form-field form-field--important" id="groq-api-key-field">
              <label htmlFor="api-key">API ключ: <span className="req-marker" title="Обязательная настройка">*</span></label>
              <input type="password" id="api-key" placeholder="gsk_..." />
            </div>
          </div>

          {/* Конкретные настройки выбранного провайдера (Groq) */}
          <div id="provider-specific-groq" className="provider-specific-block" >
            <div className="form-grid">
              <div className="form-field form-field--important">
                <label htmlFor="model-select">Модель: <span className="req-marker" title="Обязательная настройка">*</span></label>
                <div className="model-picker">
                  <select id="model-select">
                    <option value="whisper-large-v3-turbo">turbo (быстрая)</option>
                    <option value="whisper-large-v3">large-v3 (точная)</option>
                  </select>
                  <button id="refresh-groq-models" className="btn secondary model-refresh-btn" type="button" title="Обновить список моделей Groq" aria-label="Обновить список моделей Groq">↻</button>
                </div>
                <span id="groq-model-status" className="model-load-status" role="status" aria-live="polite" />
                <span id="groq-model-info" className="model-load-status" />
              </div>
              <div className="form-field">
                <label htmlFor="groq-language">Язык:</label>
                <select id="groq-language">
                  <option value="auto">Авто</option>
                  <option value="ru">Русский (ru)</option>
                  <option value="en">English (en)</option>
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="groq-temperature">Температура:</label>
                <input type="number" id="groq-temperature" min="0" max="1" step="0.1" defaultValue="0.0" />
              </div>
            </div>
            <div className="form-grid form-grid--spaced">
              <div className="form-field">
                <label htmlFor="groq-prompt">Системный промпт / контекст:</label>
                <textarea id="groq-prompt" className="prompt-input" rows={3} placeholder="Термины, словарь, промпт..." />
              </div>
            </div>
          </div>
          <div id="provider-specific-google-cloud" className="provider-specific-block" hidden />
          <div id="provider-specific-gemini-transcription" className="provider-specific-block" hidden />
          <div className="scenario-live-settings">
            <div className="scenario-live-settings-header">
              <h3 className="scenario-subheading">Распознавание в реальном времени</h3>
              <label className="checkbox-label scenario-live-toggle" title="Включить или выключить распознавание во время записи">
                <input type="checkbox" id="toggle-live-transcription" aria-label="Распознавать во время записи" />
              </label>
            </div>
            <div id="live-transcription-parameters" className="form-grid form-grid--three scenario-live-parameters">
              <div className="form-field compact-input-row">
                <label htmlFor="live-silence-duration">Пауза для отправки:</label>
                <input type="number" id="live-silence-duration" min="300" max="2000" step="100" />
                <span className="unit-label">мс</span>
              </div>
              <div className="form-field compact-input-row">
                <label htmlFor="live-max-chunk-duration">Максимум фрагмента:</label>
                <input type="number" id="live-max-chunk-duration" min="3" max="20" step="1" />
                <span className="unit-label">сек</span>
              </div>
              <div className="form-field compact-input-row">
                <label htmlFor="live-chunk-overlap">Перекрытие фрагментов:</label>
                <input type="number" id="live-chunk-overlap" min="0" max="2" step="0.1" />
                <span className="unit-label">сек</span>
              </div>
            </div>
          </div>
        </section>

        {/* 4. Пост-процессинг текста (Описание приложения.md:21-25, 87, 114-118) */}
        <section className="cp-card">
          <div className="card-header-row">
            <div className="card-title-group">
              <h2>Пост-процессинг текста</h2>
              <span id="postprocess-provider-status" className="status-pill status-pill--idle">Отключен</span>
            </div>
            <button id="check-gemini-settings" className="btn secondary compact-btn" type="button" title="Проверить ключ и модель без генерации текста. Запрос API может учитываться в ограничениях провайдера.">Тест</button>
          </div>
          <p id="gemini-check-result" className="model-load-status" role="status" aria-live="polite" />
          <div id="post-process-options" className="form-grid form-grid--tight">
            <div className="form-field form-field--important">
              <label htmlFor="post-process-provider">Провайдер Text-to-Text: <span className="req-marker" title="Обязательная настройка">*</span></label>
              <select id="post-process-provider">
                <option value="none">Не выбран</option>
                <option value="gemini">Google Gemini (Cloud API)</option>
              </select>
            </div>
            <div className="form-field form-field--important" id="gemini-api-key-field">
              <label htmlFor="gemini-api-key">Gemini API ключ: <span className="req-marker" title="Обязательная настройка">*</span></label>
              <input type="password" id="gemini-api-key" placeholder="AIzaSy..." />
            </div>
          </div>
          <div id="gemini-specific-block" className="form-grid--spaced">
            <div className="form-grid">
              <div className="form-field form-field--important">
                <label htmlFor="gemini-model">Модель: <span className="req-marker" title="Обязательная настройка">*</span></label>
                <div className="model-picker">
                  <select id="gemini-model">
                    <option value="">Загрузите модели из API</option>
                  </select>
                  <button id="refresh-gemini-models" className="btn secondary model-refresh-btn" type="button" title="Обновить список моделей Gemini" aria-label="Обновить список моделей Gemini">↻</button>
                </div>
                <span id="gemini-model-status" className="model-load-status" role="status" aria-live="polite" />
                <span id="gemini-model-info" className="model-load-status" />
              </div>
              <div className="form-field form-field--important" id="gemini-prompt-field">
                <label htmlFor="gemini-prompt">Промпт преобразования: <span id="gemini-prompt-required" className="req-marker" title="Обязательно при включённой постобработке" hidden>*</span></label>
                <textarea id="gemini-prompt" className="prompt-input" rows={3} aria-describedby="gemini-prompt-error" placeholder="например: сделай тезисный список / исправь пунктуацию" />
                <span id="gemini-prompt-error" className="model-load-status model-load-status--error" role="status" hidden>Укажите промпт преобразования.</span>
              </div>
            </div>
          </div>
          <div id="gemini-model-parameters" className="form-grid" />
        </section>

        <div className="cp-footer">
          <span id="save-status" className="save-status">✓ Автосохранение</span>
        </div>
        </div>

        {/* 6. История */}
        </div>
        <section className="cp-card cp-history-column">
          <div className="card-header-row">
            <h2>История</h2>
            <div className="history-limit-control">
              <label htmlFor="history-max-items">Лимит:</label>
              <select id="history-max-items" className="compact-select">
                <option value="5">5</option>
                <option value="10">10</option>
                <option value="20">20</option>
              </select>
            </div>
          </div>
          <div id="history-list" className="history-container">
            <div className="empty-history">История пуста</div>
          </div>
        </section>

      </main>
    </div>
    
  );
}
