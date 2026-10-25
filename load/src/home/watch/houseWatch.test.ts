import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GUARD_LINES } from '../../criteria/guardLines.ts';
import { LAYOUT } from '../../records/layout.ts';
import { hostSampleSchema } from '../../records/samples.ts';
import { startHouseWatch } from './houseWatch.ts';

let server: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

/** A Glances answering as the host at rest, with the given CPU. */
async function glancesWithCpu(cpuPercent: number) {
  const answers: Record<string, object> = {
    '/api/4/cpu': { total: cpuPercent },
    '/api/4/percpu': [{ total: cpuPercent }],
    '/api/4/mem': { available: 9_000_000_000, percent: 45 },
    '/api/4/memswap': { used: 2_000_000_000, sin: 100, sout: 200 },
    '/api/4/load': { min1: 0.5 },
  };
  const listening = createServer((request, response) => {
    const answer = answers[request.url ?? ''];
    response.statusCode = answer === undefined ? 404 : 200;
    response.end(JSON.stringify(answer ?? {}));
  });
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
  const address = listening.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}/api/4`;
}

const folderOf = () => mkdtempSync(join(tmpdir(), 'house-'));
const noUsers = () => ({ chatFirstBytesMs: [], attempts: 0, failed: 0, succeeded: {} });
const linesOf = (file: string, folder: string) =>
  readFileSync(join(folder, file), 'utf8').trim().split('\n');

describe('startHouseWatch', () => {
  it('keeps host samples while nothing is crossed', async () => {
    const folder = folderOf();
    const onBreach = vi.fn();
    const watch = startHouseWatch({
      folder,
      lines: GUARD_LINES,
      glancesUrl: await glancesWithCpu(10),
      intervalMs: 20,
      users: noUsers,
      onBreach,
      onFailure: vi.fn(),
    });
    await vi.waitFor(() => expect(linesOf(LAYOUT.hostSamples, folder).length).toBeGreaterThan(1));

    expect(await watch.stop()).toBeNull();
    expect(onBreach).not.toHaveBeenCalled();
    expect(
      hostSampleSchema.parse(JSON.parse(linesOf(LAYOUT.hostSamples, folder)[0] ?? '')).cpuPercent,
    ).toBe(10);
  });

  it('reports the line crossed once, and takes no more readings', async () => {
    const folder = folderOf();
    const onBreach = vi.fn();
    const watch = startHouseWatch({
      folder,
      lines: { ...GUARD_LINES, maxHostCpuPercent: 5 },
      glancesUrl: await glancesWithCpu(10),
      intervalMs: 20,
      users: noUsers,
      onBreach,
      onFailure: vi.fn(),
    });

    await vi.waitFor(() => expect(onBreach).toHaveBeenCalledTimes(1));
    const breach = await watch.stop();

    expect(breach?.line).toBe('host-cpu');
    expect(onBreach).toHaveBeenCalledTimes(1);
    expect(linesOf(LAYOUT.hostSamples, folder)).toHaveLength(1);
  });

  it('judges what the users saw as well', async () => {
    const onBreach = vi.fn();
    const watch = startHouseWatch({
      folder: folderOf(),
      lines: GUARD_LINES,
      glancesUrl: await glancesWithCpu(10),
      intervalMs: 20,
      users: () => ({ chatFirstBytesMs: [], attempts: 40, failed: 30, succeeded: {} }),
      onBreach,
      onFailure: vi.fn(),
    });

    await vi.waitFor(() => expect(onBreach).toHaveBeenCalledTimes(1));

    expect((await watch.stop())?.line).toBe('errors');
  });

  it('stops the run when it can no longer see the host', async () => {
    const onBreach = vi.fn();
    const watch = startHouseWatch({
      folder: folderOf(),
      lines: GUARD_LINES,
      glancesUrl: 'http://127.0.0.1:1/api/4',
      intervalMs: 10,
      users: noUsers,
      onBreach,
      onFailure: vi.fn(),
    });

    await vi.waitFor(() => expect(onBreach).toHaveBeenCalledTimes(1));

    expect((await watch.stop())?.line).toBe('host-unreadable');
  });

  it('ends the run with its own error when judging a reading throws', async () => {
    const onFailure = vi.fn();
    const watch = startHouseWatch({
      folder: folderOf(),
      lines: GUARD_LINES,
      glancesUrl: await glancesWithCpu(10),
      intervalMs: 10,
      users: () => {
        throw new Error('no users to read');
      },
      onBreach: vi.fn(),
      onFailure,
    });

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    await watch.stop();

    expect(onFailure.mock.calls[0]?.[0].message).toMatch(/no users to read/);
  });

  it('does not call the host blind when the run folder cannot keep a reading', async () => {
    const onBreach = vi.fn();
    const onFailure = vi.fn();
    const folderThatIsAFile = join(folderOf(), 'full');
    writeFileSync(folderThatIsAFile, '');
    const watch = startHouseWatch({
      folder: folderThatIsAFile,
      lines: GUARD_LINES,
      glancesUrl: await glancesWithCpu(10),
      intervalMs: 10,
      users: noUsers,
      onBreach,
      onFailure,
    });

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));

    expect(await watch.stop()).toBeNull();
    expect(onFailure.mock.calls[0]?.[0].message).toMatch(/could not keep a host reading/);
    expect(onBreach).not.toHaveBeenCalled();
  });
});
