import { expect, it } from 'vitest';
import { allocateScenarioColumns } from './scenario-column-layout';

it('keeps sibling starts aligned with independent heights', () => {
  expect(allocateScenarioColumns([
    { top: 24, height: 180 }, { parent: 0, top: 24, height: 500 },
  ])).toEqual([0, 1]);
});

it('places a nested branch after its own parent column', () => {
  expect(allocateScenarioColumns([
    { top: 24, height: 600 }, { parent: 0, top: 24, height: 300 },
    { parent: 1, top: 130, height: 200 },
  ])).toEqual([0, 1, 2]);
});

it('places later forks closer to the parent than earlier branches', () => {
  expect(allocateScenarioColumns([
    { top: 24, height: 700 }, { parent: 0, top: 24, height: 100 },
    { parent: 0, top: 124, height: 200 },
  ])).toEqual([0, 2, 1]);
});

it('does not route a later fork through an earlier tall branch', () => {
  expect(allocateScenarioColumns([
    { top: 24, height: 700 }, { parent: 0, top: 24, height: 500 },
    { parent: 0, top: 124, height: 200 },
  ])).toEqual([0, 2, 1]);
});

it('keeps subtrees in place when settings change branch height', () => {
  const lanes = [
    { top: 24, height: 700 }, { parent: 0, top: 24, height: 250 },
    { parent: 0, top: 300, height: 50 }, { parent: 1, top: 150, height: 200 },
  ];
  expect(allocateScenarioColumns(lanes)).toEqual([0, 2, 1, 3]);
  lanes[2].height = 600;
  expect(allocateScenarioColumns(lanes)).toEqual([0, 2, 1, 3]);
});

it('keeps the two transcription subtrees separate instead of crossing their text buses', () => {
  const lanes = [
    { top: 24, height: 500 },
    { parent: 0, top: 24, height: 600 },
    { parent: 0, top: 120, height: 180 },
    { parent: 1, top: 120, height: 180 },
  ];
  const columns = allocateScenarioColumns(lanes);
  expect(columns).toEqual([0, 2, 1, 3]);
  for (let target = 0; target < lanes.length; target++) {
    const parent = lanes[target].parent;
    if (parent === undefined) continue;
    for (let other = 0; other < lanes.length; other++) {
      if (columns[other] <= columns[parent] || columns[other] >= columns[target]) continue;
      expect(lanes[other].top >= lanes[target].top || lanes[other].top + lanes[other].height <= lanes[target].top).toBe(true);
    }
  }
});

it('avoids crossings across multiple fork levels within both transcription branches', () => {
  const lanes = [
    { top: 24, height: 1200 }, { parent: 0, top: 24, height: 700 },
    { parent: 0, top: 160, height: 500 }, { parent: 2, top: 210, height: 300 },
    { parent: 0, top: 400, height: 300 }, { parent: 1, top: 140, height: 500 },
    { parent: 1, top: 400, height: 150 },
  ];
  const columns = allocateScenarioColumns(lanes);
  expect(columns).toEqual([0, 4, 2, 3, 1, 6, 5]);
  for (let target = 0; target < lanes.length; target++) {
    const parent = lanes[target].parent;
    if (parent === undefined) continue;
    for (let other = 0; other < lanes.length; other++) {
      if (columns[other] <= columns[parent] || columns[other] >= columns[target]) continue;
      expect(lanes[other].top >= lanes[target].top || lanes[other].top + lanes[other].height <= lanes[target].top).toBe(true);
    }
  }
});
