import type { SelectOption } from '../kit/blueprint.ts';
/** Linux Fargate pairs: CPU in ECS units and memory in MiB. Batch converts CPU units once to vCPU. */
export const AWS_FARGATE_SIZES: SelectOption[] = [];
for (const [cpu, memories] of [
  [256, [512, 1024, 2048]], [512, [1024, 2048, 3072, 4096]],
  [1024, Array.from({ length: 7 }, (_, i) => (i + 2) * 1024)],
  [2048, Array.from({ length: 13 }, (_, i) => (i + 4) * 1024)],
  [4096, Array.from({ length: 23 }, (_, i) => (i + 8) * 1024)],
  [8192, Array.from({ length: 12 }, (_, i) => (i * 4 + 16) * 1024)],
  [16384, Array.from({ length: 12 }, (_, i) => (i * 8 + 32) * 1024)],
] as const) for (const memory of memories) AWS_FARGATE_SIZES.push({ value: cpu + ':' + memory, group: cpu / 1024 + ' vCPU', label: cpu / 1024 + ' vCPU / ' + memory + ' MiB' });
