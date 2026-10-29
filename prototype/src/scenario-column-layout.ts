interface Lane {
  id?: string;
  element: HTMLElement;
  parts: HTMLElement[];
  entry?: Junction;
  parent?: number;
  top: number;
  column: number;
}
interface Junction {
  element: HTMLElement;
  origin: Lane;
  lanes: Lane[];
  rails: HTMLElement[];
}

const layoutDisposers = new WeakMap<HTMLElement, () => void>();
export function disposeScenarioColumns(root: HTMLElement): void {
  for (const tree of [root, ...root.querySelectorAll<HTMLElement>('.scenario-column-grid')]) {
    layoutDisposers.get(tree)?.();
    layoutDisposers.delete(tree);
  }
}

/** Keep whole subtrees together; later forks stay nearer their parent to avoid crossings. */
export function allocateScenarioColumns(lanes: { parent?: number; top: number; height: number }[]): number[] {
  const columns: number[] = [];
  let nextColumn = 0;
  const place = (index: number) => {
    columns[index] = nextColumn++;
    lanes.map((lane, child) => ({ lane, child }))
      .filter(item => item.lane.parent === index)
      .sort((left, right) => right.lane.top - left.lane.top || left.child - right.child)
      .forEach(item => place(item.child));
  };
  lanes.forEach((lane, index) => { if (lane.parent === undefined) place(index); });
  return columns;
}

/** Columns share X coordinates, while each branch lays out its own vertical chain. */
export function alignScenarioColumns(tree: HTMLElement): () => void {
  const lanes: Lane[] = [];
  const junctions: Junction[] = [];
  const pending: { container: HTMLElement; lane: Lane }[] = [];
  const makeLane = (container: HTMLElement): Lane => ({
    id: container.dataset.flowBranch, element: document.createElement('div'), parts: [], top: 0, column: 0,
  });
  const columnsOf = (element: HTMLElement) => [...element.children]
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('scenario-tree-column'));
  const readTree = (element: HTMLElement, main: Lane, root = false) => {
    const columns = columnsOf(element);
    const connection = element.querySelector<HTMLElement>(':scope > .scenario-connection') ?? document.createElement('div');
    const junction: Junction = { element: connection, origin: main, lanes: [main], rails: [] };
    junctions.push(junction);
    if (root) main.entry = junction;
    else main.parts.push(connection);
    for (const column of columns.slice(1)) {
      const lane = makeLane(column);
      lane.entry = junction;
      junction.lanes.push(lane);
      pending.push({ container: column, lane });
    }
    readChain(columns[0], main);
  };
  const readChain = (container: HTMLElement, lane: Lane) => {
    for (const child of [...container.children]) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.classList.contains('scenario-pipeline-stage')) {
        lane.parts.push(...[...child.children].filter((part): part is HTMLElement => part instanceof HTMLElement));
      } else if (child.classList.contains('scenario-transformation-tree')) readTree(child, lane);
      else if (child.classList.contains('scenario-add-row')) lane.parts.push(child);
    }
  };
  const rootColumns = columnsOf(tree);
  if (!rootColumns.length) return () => {};
  const main = makeLane(rootColumns[0]);
  readTree(tree, main, true);
  lanes.push(main);
  for (let index = 0; index < pending.length; index++) {
    const { container, lane } = pending[index];
    readChain(container, lane);
    lane.parent = lanes.indexOf(lane.entry!.origin);
    lanes.push(lane);
  }

  tree.replaceChildren();
  tree.classList.add('scenario-column-grid');
  for (const lane of lanes) {
    lane.element.className = 'scenario-tree-column scenario-grid-lane';
    if (lane.id) lane.element.dataset.flowBranch = lane.id;
    lane.element.append(...lane.parts);
    tree.append(lane.element);
  }
  tree.append(junctions[0].element);
  for (const junction of junctions) {
    for (const lane of junction.lanes) {
      const rail = document.createElement('span');
      rail.className = `scenario-tree-input-rail ${lane === junction.origin
        ? 'scenario-tree-input-rail--origin' : 'scenario-tree-input-rail--last'}`;
      if (lane.id) rail.dataset.flowBranch = lane.id;
      rail.dataset.inputStepIds = junction.element.dataset.inputStepIds ?? '[]';
      rail.setAttribute('aria-hidden', 'true');
      junction.rails.push(rail);
      tree.append(rail);
    }
  }

  let frame: number | undefined;
  let disposed = false;
  const layout = () => {
    frame = undefined;
    if (disposed || !tree.isConnected) return;
    const treeTop = tree.getBoundingClientRect().top;
    const laneRects = lanes.map(lane => lane.element.getBoundingClientRect());
    const connections = new Map(junctions.map(junction => [junction, junction.element.getBoundingClientRect()]));
    const sizes: { parent?: number; top: number; height: number }[] = [];
    for (const [index, lane] of lanes.entries()) {
      const entry = lane.entry!;
      const connection = connections.get(entry)!;
      lane.top = lane === main ? connection.height
        : entry.origin.top + connection.bottom - laneRects[lanes.indexOf(entry.origin)].top;
      sizes.push({ parent: lane.parent, top: lane.top, height: laneRects[index].height });
    }
    const columns = allocateScenarioColumns(sizes);
    const width = laneRects[0].width;
    const gap = parseFloat(getComputedStyle(tree).columnGap) || 0;
    lanes.forEach((lane, index) => {
      lane.column = columns[index];
      lane.element.style.marginTop = `${lane.top}px`;
      lane.element.style.gridColumn = String(lane.column + 1);
    });
    tree.style.gridTemplateColumns = `repeat(${Math.max(...columns) + 1}, var(--scenario-lane-width))`;
    const junctionRects = junctions.map(junction => ({
      rect: junction.element.getBoundingClientRect(),
      badge: junction.element.querySelector('.scenario-connection-type')?.getBoundingClientRect(),
    }));
    for (const [junctionIndex, junction] of junctions.entries()) {
      const { rect, badge } = junctionRects[junctionIndex];
      const junctionY = badge ? badge.top + badge.height / 2 : rect.top + rect.height / 2;
      const last = Math.max(...junction.lanes.map(lane => lane.column));
      junction.element.style.setProperty('--scenario-parallel-span',
        `${(last - junction.origin.column) * (width + gap)}px`);
      junction.rails.forEach((rail, index) => {
        rail.style.left = `${junction.lanes[index].column * (width + gap)}px`;
        const top = junction.lanes[index] === junction.origin ? rect.top : junctionY;
        rail.style.top = `${top - treeTop}px`;
        rail.style.height = `${rect.bottom - top}px`;
        rail.style.setProperty('--scenario-junction-span', String(last - junction.origin.column));
      });
    }
  };
  const schedule = () => {
    if (!disposed && frame === undefined) frame = requestAnimationFrame(layout);
  };
  const resize = new ResizeObserver(schedule);
  lanes.forEach(lane => resize.observe(lane.element));
  junctions.forEach(junction => resize.observe(junction.element));
  schedule();
  const dispose = () => {
    disposed = true;
    resize.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
  layoutDisposers.set(tree, dispose);
  return dispose;
}
