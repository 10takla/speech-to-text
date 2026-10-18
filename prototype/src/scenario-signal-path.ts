interface Point { x: number; y: number }
export interface ScenarioSignalSegment {
  x: number;
  y: number;
  length: number;
  horizontal: boolean;
  reverse: boolean;
}

/** Follow the data rail through a junction, without crossing step cards. */
export function scenarioSignalPath(from: Point, to: Point, junctionY?: number): ScenarioSignalSegment[] {
  const points = junctionY === undefined ? [from, to]
    : [from, { x: from.x, y: junctionY }, { x: to.x, y: junctionY }, to];
  return points.slice(1).flatMap((end, index) => {
    const start = points[index];
    const horizontal = start.y === end.y;
    if (!horizontal && start.x !== end.x) return [];
    const distance = horizontal ? end.x - start.x : end.y - start.y;
    return distance === 0 ? [] : [{
      x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      length: Math.abs(distance), horizontal, reverse: distance < 0,
    }];
  });
}
