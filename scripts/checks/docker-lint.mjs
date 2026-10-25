#!/usr/bin/env node
/**
 * docker-lint — runs hadolint over the repo Dockerfiles when available,
 * otherwise falls back to the official docker image, otherwise warns and
 * skips (only a missing tool ever skips — lint findings DO fail the gate).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['Dockerfile.backend', 'Dockerfile.frontend', 'load/Dockerfile'].filter((f) =>
  existsSync(join(ROOT, f)),
);

// Info-level findings (e.g. DL3066: `USER node`/`USER nginx` — both users
// exist in their base images) stay visible but do not fail the gate.
const HADOLINT_ARGS = ['--failure-threshold', 'warning'];

function hasBinary() {
  const probe = spawnSync('hadolint', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function tryDockerImage() {
  const probe = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  if (probe.status !== 0) return null;
  let ok = true;
  for (const f of FILES) {
    const r = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '-v',
        `${ROOT}:/work`,
        'ghcr.io/hadolint/hadolint',
        'hadolint',
        ...HADOLINT_ARGS,
        `/work/${f}`,
      ],
      { stdio: 'inherit' },
    );
    ok = ok && r.status === 0;
  }
  return ok;
}

if (FILES.length === 0) process.exit(0);

// Binary present: its verdict is the gate's verdict (do not fall through).
if (hasBinary()) {
  const r = spawnSync('hadolint', [...HADOLINT_ARGS, ...FILES], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const dockerResult = tryDockerImage();
if (dockerResult === true) process.exit(0);
if (dockerResult === false) process.exit(1);
console.warn(
  '⚠️  hadolint unavailable (no binary, no docker) — skipping Dockerfile lint.\n' +
    '   Install via: brew install hadolint | apt install hadolint, or run with Docker available.',
);
