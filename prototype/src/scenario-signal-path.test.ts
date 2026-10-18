import { expect, it } from 'vitest';
import { scenarioSignalPath } from './scenario-signal-path';

it('follows a straight vertical rail', () => {
  expect(scenarioSignalPath({ x: 0, y: 10 }, { x: 0, y: 90 })).toEqual([
    { x: 0, y: 10, length: 80, horizontal: false, reverse: false },
  ]);
});

it('follows the junction horizontally before descending into the target branch', () => {
  expect(scenarioSignalPath({ x: 0, y: 10 }, { x: 416, y: 110 }, 70)).toEqual([
    { x: 0, y: 10, length: 60, horizontal: false, reverse: false },
    { x: 0, y: 70, length: 416, horizontal: true, reverse: false },
    { x: 416, y: 70, length: 40, horizontal: false, reverse: false },
  ]);
});

it('starts nested forks in their parent column', () => {
  expect(scenarioSignalPath({ x: 416, y: 100 }, { x: 832, y: 180 }, 140)[1]).toEqual(
    { x: 416, y: 140, length: 416, horizontal: true, reverse: false },
  );
});

it('omits empty legs and keeps the direction when following a rail backwards', () => {
  expect(scenarioSignalPath({ x: 50, y: 20 }, { x: 0, y: 20 }, 20)).toEqual([
    { x: 0, y: 20, length: 50, horizontal: true, reverse: true },
  ]);
  expect(scenarioSignalPath({ x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([]);
});

it('never draws a diagonal shortcut through cards without a junction', () => {
  expect(scenarioSignalPath({ x: 0, y: 10 }, { x: 416, y: 90 })).toEqual([]);
});
