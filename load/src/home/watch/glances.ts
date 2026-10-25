import { z } from 'zod';

/** Where the home machine's Glances answers, unless told otherwise. */
export const DEFAULT_GLANCES_URL = 'http://192.168.50.236:61208/api/4';

const cpuSchema = z.object({ total: z.number() });
const perCoreSchema = z.array(z.object({ total: z.number() }));
const memorySchema = z.object({ available: z.number(), percent: z.number() });
const swapSchema = z.object({ used: z.number(), sin: z.number(), sout: z.number() });
const loadSchema = z.object({ min1: z.number() });

/** What Glances answered for each reading, as parsed JSON. */
type GlancesAnswers = {
  cpu: unknown;
  perCore: unknown;
  memory: unknown;
  swap: unknown;
  load: unknown;
};

/** One host reading from Glances's answers, taken at `at`. Throws when an answer is not what Glances documents. */
export function hostSampleFrom(answers: GlancesAnswers, at: Date) {
  const cpu = cpuSchema.parse(answers.cpu);
  const memory = memorySchema.parse(answers.memory);
  const swap = swapSchema.parse(answers.swap);
  return {
    at: at.toISOString(),
    cpuPercent: cpu.total,
    perCorePercent: perCoreSchema.parse(answers.perCore).map((core) => core.total),
    memoryAvailableBytes: memory.available,
    memoryUsedPercent: memory.percent,
    swapUsedBytes: swap.used,
    swapInBytes: swap.sin,
    swapOutBytes: swap.sout,
    loadAverage1: loadSchema.parse(answers.load).min1,
  };
}

/** Reads the host from Glances. Throws when Glances does not answer in time or answers something unexpected. */
export async function readHostSample(baseUrl: string) {
  const [cpu, perCore, memory, swap, load] = await Promise.all(
    ['cpu', 'percpu', 'mem', 'memswap', 'load'].map((path) => getJson(`${baseUrl}/${path}`)),
  );
  return hostSampleFrom({ cpu, perCore, memory, swap, load }, new Date());
}

async function getJson(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}
