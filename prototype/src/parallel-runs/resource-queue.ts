type Slot = {
  id: string;
  // Goes ahead of other actions of earlier runs, see `drain`.
  priority?: boolean;
  ready?: () => Promise<void>;
  reject?: (error: unknown) => void;
  running?: boolean;
};

/** Reserve actions at launch, before their inputs are ready. */
export function createResourceQueue() {
  const runs = new Map<string, Slot[]>();
  let busy = false;
  let paused = false;
  const cancelled = () => new DOMException('Запуск отменён', 'AbortError');
  // Runs keep their order, except that a ready action without priority (a copy)
  // waits while the next run is about to do a priority action (a paste): the text
  // appears in the field without waiting for the previous copy's clipboard
  // history updates. Only a run whose next action is the paste is waited for,
  // so a paste that itself waits for the run's copy cannot deadlock the queue.
  const drain = () => {
    if (busy || paused) return;
    const queued = [...runs.values()].filter(items => items.length > 0);
    let slots: Slot[] | undefined, slot: Slot | undefined;
    let yielding = false;
    for (const [index, items] of queued.entries()) {
      if (yielding) {
        // Only a paste may pass the waiting copy, and pastes keep their order.
        if (items[0].priority && items[0].ready) { slots = items; slot = items[0]; }
        break;
      }
      const ready = items.find(item => item.ready);
      if (!ready) break;
      // A run with its own paste still to do does not yield: pastes keep their order.
      if (!ready.priority && !items.some(item => item.priority) && queued[index + 1]?.[0].priority) { yielding = true; continue; }
      slots = items; slot = ready;
      break;
    }
    if (!slot || !slots) return;
    busy = true;
    slot.running = true;
    void slot.ready!().finally(() => {
      slots!.splice(slots!.indexOf(slot), 1);
      busy = false;
      drain();
    });
  };
  return {
    register(runId: string, stepIds: string[], priorityIds: readonly string[] = []) {
      runs.set(runId, stepIds.map(id => ({ id, priority: priorityIds.includes(id) })));
    },
    execute<T>(runId: string, stepId: string, operation: () => Promise<T>, onWaiting?: (waiting: boolean) => void): Promise<T> {
      const slot = runs.get(runId)?.find(item => item.id === stepId);
      if (!slot) return Promise.reject(cancelled());
      onWaiting?.(true);
      return new Promise<T>((resolve, reject) => {
        slot.reject = reject;
        slot.ready = async () => {
          onWaiting?.(false);
          try { resolve(await operation()); } catch (error) { reject(error); }
        };
        drain();
      });
    },
    skip(runId: string, stepIds: readonly string[]) {
      const slots = runs.get(runId);
      if (!slots) return;
      for (let index = slots.length - 1; index >= 0; index--) {
        const slot = slots[index];
        if (!slot.running && stepIds.includes(slot.id)) {
          slots.splice(index, 1);
          slot.reject?.(cancelled());
        }
      }
      drain();
    },
    finish(runId: string) {
      const slots = runs.get(runId);
      runs.delete(runId);
      slots?.filter(slot => !slot.running).forEach(slot => slot.reject?.(cancelled()));
      drain();
    },
    setPaused(value: boolean) { paused = value; drain(); },
  };
}
