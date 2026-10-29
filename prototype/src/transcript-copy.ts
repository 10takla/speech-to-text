/** Copy transcript text without line breaks introduced by segment/playback layout. */
export function attachTranscriptCopy(host: HTMLElement) {
  const document = host.ownerDocument;
  const copy = (event: ClipboardEvent) => {
    const selection = document.getSelection();
    if (event.defaultPrevented || !event.clipboardData || !selection || selection.isCollapsed
      || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    if (!host.contains(range.startContainer) || !host.contains(range.endContainer)) return;

    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Explicit spaces between segments belong to editor-segments as well.
      if (!node.parentElement?.closest('.editor-segments') || !range.intersectsNode(node)) continue;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.textContent!.length;
      parts.push(node.textContent!.slice(start, end));
    }
    if (!parts.length) return;
    event.clipboardData.setData('text/plain', parts.join(''));
    event.preventDefault();
  };
  document.addEventListener('copy', copy);
  return () => document.removeEventListener('copy', copy);
}
