// Measure the balanced layout first so a long history never creates a fourth column.
// Then fill each column down to at least the bottom of the window.
export function observeHistoryColumns(): () => void {
  const main = document.querySelector<HTMLElement>('.cp-main');
  if (!main) return () => {};
  let frame = 0;

  const update = () => {
    frame = 0;
    main.style.removeProperty('height');
    main.style.removeProperty('column-fill');
    if (getComputedStyle(main).columnCount !== '3') return;
    const height = Math.ceil(main.getBoundingClientRect().height);
    main.style.height = `${height}px`;
    main.style.columnFill = 'auto';
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  const resizeObserver = new ResizeObserver(schedule);
  const observeContent = () => {
    resizeObserver.disconnect();
    const panel = main.closest('#control-panel-app');
    if (panel) resizeObserver.observe(panel);
    main.querySelectorAll('.cp-column, .history-item, .card-header-row, .history-date-heading')
      .forEach(element => resizeObserver.observe(element));
  };
  const mutationObserver = new MutationObserver(mutations => {
    if (mutations.every(mutation => mutation.target === main)) return;
    observeContent();
    schedule();
  });
  mutationObserver.observe(main, { subtree: true, childList: true, characterData: true, attributes: true });
  observeContent();
  window.addEventListener('resize', schedule);
  document.fonts.addEventListener('loadingdone', schedule);
  schedule();

  return () => {
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    window.removeEventListener('resize', schedule);
    document.fonts.removeEventListener('loadingdone', schedule);
    main.style.removeProperty('height');
    main.style.removeProperty('column-fill');
  };
}
