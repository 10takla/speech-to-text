type Slot = {
  id: string;
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
  const drain = () => {
    if (busy || paused) return;
    const slots = [...runs.values()].find(items => items.length > 0);
    const slot = slots?.find(item => item.ready);
    if (!slot) return;
    busy = true;
    slot.running = true;
    void slot.ready!().finally(() => {
      slots!.splice(slots!.indexOf(slot), 1);
      busy = false;
      drain();
    });
  };
  return {
    register(runId: string, stepIds: string[]) {
      runs.set(runId, stepIds.map(id => ({ id })));
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
