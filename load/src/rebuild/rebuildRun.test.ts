import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYOUT } from '../records/index.ts';
import { rebuildRun } from './rebuildRun.ts';
import { STATEMENTS_NOT_KEPT } from './report/sections/beyondTheDashboard.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

/** Copies a fixture run folder, so that a rebuild never writes into the fixture. */
function copyOf(name: string) {
  const folder = join(mkdtempSync(join(tmpdir(), 'rebuild-')), name);
  cpSync(join(FIXTURES, name), folder, { recursive: true });
  return folder;
}

/** Every file under `derived/`, by path, with its content. */
function derivedOf(folder: string) {
  return Object.fromEntries(
    readdirSync(join(folder, LAYOUT.derivedDir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(folder.length + 1), readFileSync(path, 'utf8')];
      }),
  );
}

const DERIVED = [
  LAYOUT.summary,
  LAYOUT.verdict,
  LAYOUT.metricsTable,
  LAYOUT.eventsLog,
  LAYOUT.report,
];

describe.each([
  { name: 'home-smoke-pass', verdict: 'pass' },
  { name: 'home-smoke-guard-stop', verdict: 'fail' },
  { name: 'aws-smoke-pass', verdict: 'pass' },
  { name: 'aws-step50-pass', verdict: 'pass' },
  { name: 'aws-step10-short', verdict: 'fail' },
])('rebuilding the $name fixture', ({ name, verdict }) => {
  it(`judges it a ${verdict}, giving reasons only for a run that is not a pass`, () => {
    const rebuilt = rebuildRun(copyOf(name));

    expect(rebuilt.verdict).toBe(verdict);
    if (verdict === 'pass') expect(rebuilt.reasons).toEqual([]);
    else expect(rebuilt.reasons).not.toEqual([]);
  });

  it('writes every derived file, and nothing else', () => {
    const folder = copyOf(name);
    const rebuilt = rebuildRun(folder);

    expect([...rebuilt.written].sort()).toEqual([...DERIVED].sort());
    expect(Object.keys(derivedOf(folder)).sort()).toEqual([...DERIVED].sort());
  });

  it('gives the same bytes when it is rebuilt again, from a copy made elsewhere', () => {
    const first = copyOf(name);
    const second = copyOf(name);
    rebuildRun(first);
    rebuildRun(second);
    rebuildRun(second);

    expect(derivedOf(second)).toEqual(derivedOf(first));
  });
});

describe('rebuilding a run of step50 that held every user', () => {
  const rebuilt = rebuildRun(copyOf('aws-step50-pass'));

  it('judges it by step50’s lines, each in the direction it is held', () => {
    expect(rebuilt.verdictText).toContain(
      '| Push streams open through the hold | at least 49,000 | 50,000 | pass |',
    );
    expect(rebuilt.verdictText).toContain(
      '| Chatters active through the hold | at least 9,800 | 10,000 | pass |',
    );
    expect(rebuilt.verdictText).toContain('| Busiest generator CPU | at most 70% | 40% | pass |');
    expect(rebuilt.verdictText).toContain(
      '| Chat first byte p95 | at most 2500 ms | 136 ms | pass |',
    );
  });
});

describe('rebuilding a run of step10 whose second generator lost a fifth of its push streams', () => {
  const rebuilt = rebuildRun(copyOf('aws-step10-short'));

  it('judges it by the same family of lines, scaled to its ten thousand users', () => {
    expect(rebuilt.verdictText).toContain(
      '| Chatters active through the hold | at least 1,960 | 2,000 | pass |',
    );
    expect(rebuilt.verdictText).toContain('| Busiest generator CPU | at most 70% | 40% | pass |');
  });

  it('fails on the push streams alone, saying how far short they fell', () => {
    expect(rebuilt.verdictText).toContain(
      '| Push streams open through the hold | at least 9,800 | 9,000 | fail |',
    );
    expect(rebuilt.reasons).toEqual([
      'Push streams open through the hold was 9,000, short of its limit (at least 9,800)',
    ]);
  });
});

describe('rebuilding a run of step10 answers what a reading of it would otherwise have to guess', () => {
  const folder = copyOf('aws-step10-short');
  const rebuilt = rebuildRun(folder);
  const summary = JSON.parse(readFileSync(join(folder, LAYOUT.summary), 'utf8'));
  const [header = '', ...rows] = readFileSync(join(folder, LAYOUT.metricsTable), 'utf8')
    .trimEnd()
    .split('\n');
  const names = header.split('\t');
  /** The figure of one column in the minute that starts at `minute`, as the table writes it. */
  const cell = (column: string, minute: string): string | undefined =>
    rows.find((line) => line.startsWith(minute))?.split('\t')[names.indexOf(column)];

  it('names the moment and the value of the fewest push streams in the hold', () => {
    expect(rebuilt.verdictText).toContain(
      '| Fewest push streams | 9,000 | 2026-10-18T00:00:50.000Z |',
    );
    expect(summary.hold.fewestPushStreams).toEqual({
      count: 9_000,
      at: '2026-10-18T00:00:50.000Z',
    });
  });

  it('counts the push streams that ended, by the minute they ended and how long they lasted', () => {
    const minute = '2026-10-18T00:01:00.000Z';
    expect(cell('push_streams_ended_early', minute)).toBe('2');
    expect(cell('push_streams_reopened', minute)).toBe('1');
    expect(cell('push_streams_ended_lasted_1m_to_5m', minute)).toBe('2');
    expect(rebuilt.verdictText).toContain('| Of those, opened again within 10 s | 1 |');
  });

  it('sets the load balancer’s connections in each zone beside the streams the generators opened', () => {
    const minute = '2026-10-18T00:01:00.000Z';
    expect(cell('balancer_active_connections_by_zone_ap_southeast_2a', minute)).toBe('4');
    expect(cell('balancer_active_connections_by_zone_ap_southeast_2b', minute)).toBe('1');
    expect(cell('push_streams_opened', minute)).toBe('1');
  });

  it('spreads worker and database CPU over the jobs started, and splits the jobs by task', () => {
    const minute = '2026-10-18T00:01:00.000Z';
    expect(cell('worker_cpu_ms_per_job', minute)).toBe('60');
    expect(cell('db_cpu_ms_per_job', minute)).toBe('20400');
    expect(cell('jobs_started_driftGateJudgeArrival', minute)).toBe('1');
    expect(cell('job_run_mean_ms_driftGateJudgeArrival', minute)).toBe('30');
  });

  it('gives each copy’s figures, not only the busiest copy’s', () => {
    expect(cell('copy_db_connections_waiting_api_7f3a90c2', '2026-10-18T00:00:00.000Z')).toBe(
      '159',
    );
    expect(summary.app.byCopy['api-7f3a90c2']).toMatchObject({ peakDbConnectionsWaiting: 159 });
    expect(summary.app.byCopy['worker-worker-1']).toMatchObject({ peakDbConnectionsWaiting: 1 });
  });

  it('takes the chat first byte p95 over the hold alone', () => {
    expect(summary.hold).toMatchObject({ chatsStreamed: 1, chatFirstByteP95Ms: 100 });
    expect(rebuilt.verdictText).toContain(
      '| Chat first byte p95, in the hold alone | 100 ms over 1 chat |',
    );
  });

  it('lists the statements behind each wait the run kept them for', () => {
    expect(summary.insights.statementsByWait).toEqual([
      {
        wait: 'Lock:object',
        statements: [
          {
            statement: 'insert into "billing"."daily_spend" ("day", "slot") values ($1, $2)',
            id: 'B7',
            meanSessions: 0.9,
            peakSessions: 0.9,
          },
        ],
      },
    ]);
  });
});

describe('rebuilding a run that kept the waits but not the statements behind them', () => {
  it('says so in its report and its summary', () => {
    const folder = copyOf('aws-smoke-pass');
    rebuildRun(folder);
    const summary = JSON.parse(readFileSync(join(folder, LAYOUT.summary), 'utf8'));

    expect(summary.insights.statementsByWait).toBeNull();
    expect(readFileSync(join(folder, LAYOUT.report), 'utf8')).toContain(STATEMENTS_NOT_KEPT);
  });
});

describe('rebuilding a run whose slice was down', () => {
  const folder = copyOf('home-smoke-pass');
  const manifestPath = join(folder, LAYOUT.manifest);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const [slice] = manifest.slices;
  const window = {
    from: '2026-10-15T00:00:30.000Z',
    to: '2026-10-15T00:00:50.000Z',
    reason:
      'its generator stopped (interrupted: reclaimed); a new generator brought the users back',
  };
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, slices: [{ ...slice, down: [window] }] }),
  );
  const rebuilt = rebuildRun(folder);

  it('names the window as a gap, with the slice and how long it was down', () => {
    expect(rebuilt.verdictText).toContain(
      `| generator 0 | ${window.from} | ${window.to} | users 0 to 3 were down for 20 s: ${window.reason} |`,
    );
    expect(rebuilt.verdictText).toContain('## Slices');
  });

  it("still judges the run, without the slice's own requests inside the window", () => {
    expect(rebuilt.verdict).toBe('pass');
    const summary = JSON.parse(readFileSync(join(folder, LAYOUT.summary), 'utf8'));
    expect(summary.slices).toMatchObject([{ generator: 0, downSeconds: 20 }]);
  });
});

describe('rebuilding a run whose step had no limits when it began', () => {
  it('names the run as not judged, and does not crash', () => {
    const folder = copyOf('aws-smoke-pass');
    const manifestPath = join(folder, LAYOUT.manifest);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, step: 'step100', limits: null }));

    const rebuilt = rebuildRun(folder);

    expect(rebuilt.verdict).toBe('incomplete');
    expect(rebuilt.reasons.join(' ')).toMatch(/could not be judged: no limits were defined/);
  });

  it('names a limit that no criterion judges, rather than guessing at it', () => {
    const folder = copyOf('home-smoke-pass');
    const manifestPath = join(folder, LAYOUT.manifest);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, limits: { maxSomethingElse: 1 } }));

    const rebuilt = rebuildRun(folder);

    expect(rebuilt.verdict).toBe('incomplete');
    expect(rebuilt.reasons.join(' ')).toMatch(/could not be judged: .*maxSomethingElse/);
  });
});
