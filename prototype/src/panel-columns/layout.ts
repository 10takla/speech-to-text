import { createSectionBackgrounds } from './section-backgrounds';

/** Use the window height while content fits; let CSS balance overflowing content. */
export function observePanelColumns(main: HTMLElement): () => void {
  const panel = main.closest<HTMLElement>('#control-panel-app') ?? main;
  const backgrounds = createSectionBackgrounds(main);
  let frame = 0;
  let disposed = false;
  let panelWidth = -1;

  const clear = () => {
    main.style.removeProperty('height');
    main.style.removeProperty('column-fill');
  };
  const update = () => {
    frame = 0;
    clear();
    if (disposed || !main.isConnected) return;
    if (document.body.classList.contains('android-app')) { backgrounds.update(); return; }
    const style = getComputedStyle(main);
    const columnWidth = parseFloat(style.columnWidth);
    const gap = parseFloat(style.columnGap) || 0;
    // column-count is a maximum: narrow windows still use a single column.
    if (!Number.isFinite(columnWidth) || main.clientWidth + gap < 2 * (columnWidth + gap)) {
      backgrounds.update();
      return;
    }

    const rect = main.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const bottomPadding = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
    const available = Math.max(0, document.documentElement.clientHeight - top - bottomPadding);
    if (Math.ceil(rect.height) <= available) {
      main.style.height = `${available}px`;
      main.style.columnFill = 'auto';
    }
    backgrounds.update();
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(update);
  };
  const resize = new ResizeObserver(entries => {
    if (entries.some(entry => {
      if (entry.target !== panel) return true;
      const changed = entry.contentRect.width !== panelWidth;
      panelWidth = entry.contentRect.width;
      return changed;
    })) schedule();
  });
  const observeContent = () => {
    resize.disconnect();
    resize.observe(panel);
    main.querySelectorAll('.cp-settings-column > .cp-card, .scenario-card, .history-item, '
      + '.card-header-row, .history-date-heading, .empty-history, .cp-footer, .scenario-add-scenario')
      .forEach(element => resize.observe(element));
  };
  const mutations = new MutationObserver(records => {
    if (records.every(record => record.target === main || backgrounds.owns(record.target))) return;
    if (records.some(record => record.type === 'childList')) observeContent();
    schedule();
  });
  mutations.observe(main, { subtree: true, childList: true, characterData: true, attributes: true });
  observeContent();
  window.addEventListener('resize', schedule);
  document.fonts.addEventListener('loadingdone', schedule);
  schedule();

  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    window.removeEventListener('resize', schedule);
    document.fonts.removeEventListener('loadingdone', schedule);
    clear();
    backgrounds.dispose();
  };
}
