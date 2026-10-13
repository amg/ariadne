import { lookup } from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';
import type { DirectPath, Plan } from './plan.ts';

/**
 * The direct path measures aws-prod without Cloudflare in front. Requests
 * still name the public hostname, so the load balancer sees the Host header
 * and TLS name it always sees; only two things change. The hostname
 * resolves to the load balancer rather than to Cloudflare, and the
 * generator presents its own client certificate where Cloudflare would
 * present Cloudflare's. Every fetch in the generator goes through it.
 */
export function takeDirectPath(direct: DirectPath): void {
  setGlobalDispatcher(
    new Agent({
      connect: {
        cert: direct.certificate,
        key: direct.key,
        // Cloudflare's Origin CA signs the origin's certificate, and only
        // Cloudflare trusts that authority. The address itself comes from
        // aws-prod's own stack.
        rejectUnauthorized: false,
        lookup: (_hostname, options, callback) => lookup(direct.originAddress, options, callback),
      },
    }),
  );
}

const ORIGIN_WAIT_MS = 5 * 60_000;
const ORIGIN_RETRY_MS = 5_000;

/**
 * The load command lets a generator's address through only once its task
 * is running, so the generator waits for the origin to answer before its
 * first user starts.
 */
export async function awaitOrigin(plan: Plan): Promise<void> {
  const deadline = Date.now() + ORIGIN_WAIT_MS;
  for (;;) {
    const response = await fetch(`${plan.targetUrl}/api/health`, {
      signal: AbortSignal.timeout(ORIGIN_RETRY_MS),
    }).catch(() => null);
    await response?.body?.cancel();
    if (response?.ok) return;
    if (Date.now() > deadline) throw new Error('The origin did not answer on the direct path');
    await new Promise((resolve) => setTimeout(resolve, ORIGIN_RETRY_MS));
  }
}
