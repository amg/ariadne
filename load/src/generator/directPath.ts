import { lookup } from 'node:dns';
import { Agent, setGlobalDispatcher } from 'undici';
import { CLOUDFLARE_ORIGIN_CA } from './cloudflareOriginCa.ts';
import type { planAt } from './plan.ts';

type DirectPath = NonNullable<Parameters<typeof planAt>[0]['direct']>;

/**
 * The direct path measures aws-prod without Cloudflare in front. Requests
 * still name the public hostname, so the load balancer sees the Host header
 * and TLS name it always sees; only two things change. The hostname
 * resolves to the load balancer rather than to Cloudflare, and the
 * generator presents its own client certificate where Cloudflare would
 * present Cloudflare's. The generator checks the origin's certificate
 * against `trustedAuthority`, so a load balancer that is not the origin's
 * is refused.
 */
export function takeDirectPath(
  direct: DirectPath,
  trustedAuthority: string = CLOUDFLARE_ORIGIN_CA,
) {
  setGlobalDispatcher(
    new Agent({
      connect: {
        cert: direct.certificate,
        key: direct.key,
        // Only Cloudflare's Origin CA signs the origin's certificate, and the
        // public authorities do not, so it is the one authority trusted here.
        ca: trustedAuthority,
        lookup: (_hostname, options, callback) => lookup(direct.originAddress, options, callback),
      },
    }),
  );
}
