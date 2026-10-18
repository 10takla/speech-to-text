export interface PipelineStage<T> {
  branches: T[];
  next?: PipelineStage<T>;
  forks?: PipelineStage<T>[];
}

/** Prepend to one lane; its siblings must keep receiving the original input. */
export function prependPipelineStep<T>(current: PipelineStage<T>, added: PipelineStage<T>): PipelineStage<T> {
  added.next = current;
  added.forks = current.forks;
  current.forks = undefined;
  return added;
}

/** Remove one step while retaining its continuation and every sibling lane. */
export function removePipelineStep<T>(current: PipelineStage<T>, index: number): PipelineStage<T> | undefined {
  current.branches.splice(index, 1);
  if (current.branches.length) return current;
  const forks = [...(current.forks ?? [])];
  const replacement = current.next ?? forks.shift();
  if (replacement && forks.length) replacement.forks = [...(replacement.forks ?? []), ...forks];
  return replacement;
}
