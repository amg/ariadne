#!/usr/bin/env node
/**
 * docker-lint — runs hadolint over the repo Dockerfiles when available,
 * otherwise falls back to the official docker image, otherwise warns and
 * skips (never blocks local work over a missing optional tool).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['Dockerfile.backend', 'Dockerfile.frontend'].filter((f) =>
  existsSync(join(ROOT, f)),
);

function tryBinary() {
  const probe = spawnSync('hadolint', ['--version'], { stdio: 'ignore' });
  if (probe.status !== 0) return false;
  const r = spawnSync('hadolint', FILES, { stdio: 'inherit' });
  return r.status === 0;
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
        `/work/${f}`,
      ],
      { stdio: 'inherit' },
    );
    ok = ok && r.status === 0;
  }
  return ok;
}

if (FILES.length === 0) process.exit(0);

if (tryBinary()) process.exit(0);
const dockerResult = tryDockerImage();
if (dockerResult === true) process.exit(0);
if (dockerResult === false) process.exit(1);
console.warn(
  '⚠️  hadolint unavailable (no binary, no docker) — skipping Dockerfile lint.\n' +
    '   Install via: brew install hadolint | apt install hadolint, or run with Docker available.',
);
