// Operations return a number derived from their result to keep the work observable.
// Fixture setup and correctness checks stay outside throughput measurements.
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';

let sink = 0;
const results: BenchResult[] = [];
const filter = process.env.BLENS_BENCH_FILTER;
const runtime = {
  engine: typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`,
  platform: process.platform,
  arch: process.arch,
  cpu: cpus()[0]?.model,
};
console.log(runtime);

export interface BenchResult {
  name: string;
  medianNsPerOp: number;
  p25NsPerOp: number;
  p75NsPerOp: number;
  samples: number;
  batch: number;
}

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.round((sorted.length - 1) * q)]!;

export function bench(
  name: string,
  fn: () => number,
  opts: { warmupIters?: number; samples?: number; batch?: number } = {},
): void {
  if (filter && !name.includes(filter)) return;
  const { warmupIters = 30_000, samples = 21 } = opts;
  let batch = opts.batch ?? 10_000;
  for (let i = 0; i < warmupIters; i++) sink = (sink + fn()) | 0;
  // Target 10 ms batches outside the samples to reduce timer and scheduler noise.
  while (true) {
    const start = performance.now();
    for (let i = 0; i < batch; i++) sink = (sink + fn()) | 0;
    if (performance.now() - start >= 10 || batch >= 10_000_000) break;
    batch *= 2;
  }
  const timings: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    for (let i = 0; i < batch; i++) sink = (sink + fn()) | 0;
    timings.push((performance.now() - start) * 1e6 / batch);
  }
  timings.sort((a, b) => a - b);
  const result = {
    name, medianNsPerOp: quantile(timings, 0.5),
    p25NsPerOp: quantile(timings, 0.25), p75NsPerOp: quantile(timings, 0.75),
    samples, batch,
  };
  results.push(result);
  console.log(`${name.padEnd(42)} ${result.medianNsPerOp.toFixed(0).padStart(7)} ns/op`
    + ` (p25..p75 ${result.p25NsPerOp.toFixed(0)}..${result.p75NsPerOp.toFixed(0)})`);
}

export function finish(): void {
  if (results.length === 0) throw new Error(`No benchmarks matched ${filter}`);
  console.log('Result sink:', sink);
  if (process.env.BLENS_BENCH_JSON) {
    writeFileSync(process.env.BLENS_BENCH_JSON, JSON.stringify({ runtime, results, sink }, null, 2) + '\n');
  }
}
