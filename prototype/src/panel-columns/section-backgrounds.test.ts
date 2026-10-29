// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createSectionBackgrounds } from './section-backgrounds';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it('ends each background below its last record, including a scrolled column', () => {
  document.body.innerHTML = '<main><section class="cp-history-column" style="padding:5px;border:1px solid">'
    + '<div class="card-header-row"></div><div class="history-item"></div><div class="history-item"></div>'
    + '</section></main>';
  const main = document.querySelector('main')!;
  const section = main.querySelector('section')!;
  vi.spyOn(main, 'getBoundingClientRect').mockReturnValue(new DOMRect(8, -95, 1500, 1000));
  vi.spyOn(section, 'getClientRects').mockReturnValue([
    new DOMRect(508, -95, 480, 1000), new DOMRect(1000, -95, 480, 250),
  ] as unknown as DOMRectList);
  const positions = [new DOMRect(516, -89, 464, 25), new DOMRect(516, -60, 464, 800),
    new DOMRect(1008, -89, 464, 230)];
  [...section.children].forEach((child, index) => {
    vi.spyOn(child, 'getClientRects').mockReturnValue([positions[index]] as unknown as DOMRectList);
  });
  const backgrounds = createSectionBackgrounds(main);
  backgrounds.update();
  const boxes = [...main.querySelectorAll<HTMLElement>('.cp-section-backgrounds > div')];
  expect(boxes.map(box => [box.style.left, box.style.top, box.style.height])).toEqual([
    ['500px', '0px', '841px'], ['992px', '0px', '242px'],
  ]);
  expect(section.classList.contains('cp-fragmented-section')).toBe(true);
  // Decoration must never change the fragment's geometry or reparent records.
  expect(section.children).toHaveLength(3);
  backgrounds.dispose();
  expect(section.classList.contains('cp-fragmented-section')).toBe(false);
  expect(main.querySelector('.cp-section-backgrounds')).toBeNull();
});

it('restores the ordinary background when a section fits in one column', () => {
  document.body.innerHTML = '<main><section class="cp-scenarios cp-fragmented-section"></section></main>';
  const main = document.querySelector('main')!;
  const section = main.querySelector('section')!;
  vi.spyOn(section, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 480, 200)] as unknown as DOMRectList);
  const backgrounds = createSectionBackgrounds(main);
  backgrounds.update();
  expect(section.classList.contains('cp-fragmented-section')).toBe(false);
  expect(main.querySelector('.cp-section-backgrounds')?.children).toHaveLength(0);
  backgrounds.dispose();
});
