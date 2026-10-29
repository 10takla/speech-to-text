import { expect, it } from 'vitest';
import { prependPipelineStep, removePipelineStep, type PipelineStage } from './scenario-pipeline-edit';

const stage = (id: string, next?: PipelineStage<string>, forks?: PipelineStage<string>[]): PipelineStage<string> =>
  ({ branches: [id], next, forks });

it('removes only the selected member of a parallel action group', () => {
  const next = stage('continuation');
  const fork = stage('sibling');
  const current = { branches: ['copy', 'paste'], next, forks: [fork] };
  expect(removePipelineStep(current, 0)).toBe(current);
  expect(current).toEqual({ branches: ['paste'], next, forks: [fork] });
});

it('preserves continuation and all sibling subtrees when deleting their root', () => {
  const nested = stage('nested', stage('nested tail'));
  const sibling = stage('sibling', stage('sibling tail'));
  const next = stage('next', stage('tail'), [nested]);
  expect(removePipelineStep(stage('root', next, [sibling]), 0)).toBe(next);
  expect(next.next?.branches).toEqual(['tail']);
  expect(next.forks).toEqual([nested, sibling]);
  expect(sibling.next?.branches).toEqual(['sibling tail']);
});

it('promotes a sibling without discarding nested or remaining branches if there is no continuation', () => {
  const nested = stage('nested');
  const first = stage('first', stage('tail'), [nested]);
  const second = stage('second');
  expect(removePipelineStep(stage('root', undefined, [first, second]), 0)).toBe(first);
  expect(first.forks).toEqual([nested, second]);
  expect(first.next?.branches).toEqual(['tail']);
});

it('retains continuation even if deleting a transformation breaks data compatibility', () => {
  const textStep = stage('postprocess');
  expect(removePipelineStep(stage('transcribe', textStep), 0)).toBe(textStep);
});

it('removes an empty terminal branch', () => {
  expect(removePipelineStep(stage('last'), 0)).toBeUndefined();
});

it('inserts before a lane without moving its siblings after the inserted step', () => {
  const sibling = stage('other transcription', stage('other output'));
  const copy = stage('copy', stage('tail'), [sibling]);
  const inserted = prependPipelineStep(copy, stage('transcribe'));
  expect(inserted.next).toBe(copy);
  expect(copy.next?.branches).toEqual(['tail']);
  expect(inserted.forks).toEqual([sibling]);
  expect(copy.forks).toBeUndefined();
});

it('restores a deleted parallel root before its preserved continuation', () => {
  const copy = stage('copy');
  const root = stage('main', undefined, [stage('transcribe', copy)]);
  root.forks![0] = removePipelineStep(root.forks![0], 0)!;
  root.forks![0] = prependPipelineStep(root.forks![0], stage('new transcription'));
  expect(root.branches).toEqual(['main']);
  expect(root.forks![0].branches).toEqual(['new transcription']);
  expect(root.forks![0].next).toBe(copy);
});
