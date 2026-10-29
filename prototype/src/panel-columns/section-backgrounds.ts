const sections = '.cp-scenarios, .cp-history-column';
const content = ':scope > h2, :scope > .card-header-row, .scenario-card, '
  + '.scenario-add-scenario, .history-date-heading, .history-item, .empty-history';

/** Column fragments include unused space below an unbreakable card. Paint only occupied space. */
export function createSectionBackgrounds(main: HTMLElement) {
  const layer = document.createElement('div');
  layer.className = 'cp-section-backgrounds';
  layer.setAttribute('aria-hidden', 'true');
  main.append(layer);
  let signature = '';

  const clear = () => {
    main.querySelectorAll('.cp-fragmented-section').forEach(section => section.classList.remove('cp-fragmented-section'));
    layer.replaceChildren();
    signature = '';
  };
  return {
    owns: (node: Node) => node === layer || layer.contains(node),
    update() {
      if (document.body.classList.contains('android-app')) { clear(); return; }
      const origin = main.getBoundingClientRect();
      const boxes: { left: number; top: number; width: number; height: number }[] = [];
      for (const section of main.querySelectorAll<HTMLElement>(sections)) {
        const fragments = [...section.getClientRects()];
        const fragmented = fragments.length > 1;
        if (section.classList.contains('cp-fragmented-section') !== fragmented) {
          section.classList.toggle('cp-fragmented-section', fragmented);
        }
        if (!fragmented) continue;
        const style = getComputedStyle(section);
        const inset = (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0);
        const items = [...section.querySelectorAll<HTMLElement>(content)].flatMap(item => {
          const margin = parseFloat(getComputedStyle(item).marginBottom) || 0;
          return [...item.getClientRects()].map(rect => ({ rect, margin }));
        });
        for (const fragment of fragments) {
          const members = items.filter(({ rect }) => rect.width > 0 && rect.height > 0
            && rect.left + rect.width / 2 >= fragment.left
            && rect.left + rect.width / 2 < fragment.right);
          if (!members.length) continue;
          const bottom = Math.min(fragment.bottom, Math.max(...members.map(({ rect, margin }) => rect.bottom + margin)) + inset);
          boxes.push({ left: fragment.left - origin.left, top: fragment.top - origin.top,
            width: fragment.width, height: bottom - fragment.top });
        }
      }
      const nextSignature = JSON.stringify(boxes);
      if (nextSignature === signature) return;
      signature = nextSignature;
      layer.replaceChildren(...boxes.map(box => {
        const background = document.createElement('div');
        background.style.cssText = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`;
        return background;
      }));
    },
    dispose() { clear(); layer.remove(); },
  };
}
