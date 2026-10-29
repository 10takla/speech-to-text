// A step's «Настройки» block exists only when it has something to set: a visible
// control, or the placeholder of a shared panel that is filled in when opened.
// Notes or empty containers alone leave the step without the block.
// Only elements hidden inside `content` count: the block itself may still carry
// `hidden` from an earlier render.
export function hasStepSettings(content: Element): boolean {
  const visible = (element: Element) => {
    for (let node: Element | null = element; node && node !== content; node = node.parentElement) {
      if (node.hasAttribute('hidden')) return false;
    }
    return true;
  };
  return Array.from(content.querySelectorAll('input, select, textarea, button, [data-settings-pending]')).some(visible);
}
