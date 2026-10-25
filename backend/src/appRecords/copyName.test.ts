import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A fresh copy of the module, so each test starts from the name a process starts with. */
async function freshCopyName() {
  return import('./copyName');
}

describe('the copy a record names', () => {
  it('is the host and process outside ECS', async () => {
    vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', '');
    const { copyName, learnCopyName } = await freshCopyName();

    await learnCopyName();

    expect(copyName()).toBe(`${hostname()}:${process.pid}`);
  });

  it('is the ECS task id, as ECS answers it', async () => {
    vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', 'http://169.254.170.2/v4/abc');
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url);
      return Response.json({
        TaskARN: 'arn:aws:ecs:ap-southeast-2:123456789012:task/AriAwsApp-Cluster/0f1e2d3c4b5a',
      });
    });
    const { copyName, learnCopyName } = await freshCopyName();

    await learnCopyName();

    expect(fetched).toEqual(['http://169.254.170.2/v4/abc/task']);
    expect(copyName()).toBe('0f1e2d3c4b5a');
  });

  it('stays the host and process when ECS does not say', async () => {
    vi.stubEnv('ECS_CONTAINER_METADATA_URI_V4', 'http://169.254.170.2/v4/abc');
    vi.stubGlobal('fetch', async () => Response.json({ Cluster: 'no task here' }));
    const { copyName, learnCopyName } = await freshCopyName();

    await learnCopyName();

    expect(copyName()).toBe(`${hostname()}:${process.pid}`);
  });
});
