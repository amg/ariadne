import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOUDFLARE_ORIGIN_CA } from './cloudflareOriginCa.ts';
import { takeDirectPath } from './directPath.ts';

const HOSTNAME = 'aws-prod.example.test';

type Authority = { certificate: string; key: string; folder: string };

const openssl = (folder: string, ...args: string[]) => {
  execFileSync('openssl', args, { cwd: folder, stdio: 'ignore' });
};

/** An authority, as openssl makes one in a folder of its own. */
function authorityNamed(name: string) {
  const folder = mkdtempSync(join(tmpdir(), `direct-path-${name}-`));
  openssl(
    folder,
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    `/CN=${name}`,
  );
  return {
    folder,
    certificate: readFileSync(join(folder, 'ca.pem'), 'utf8'),
    key: readFileSync(join(folder, 'ca.key'), 'utf8'),
  };
}

/** A certificate the authority signed for `names`, with its key. */
function signedBy(authority: Authority, names: string) {
  const { folder } = authority;
  openssl(
    folder,
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
    '-subj',
    '/CN=leaf',
  );
  writeFileSync(join(folder, 'leaf.cnf'), `subjectAltName=${names}\nbasicConstraints=CA:FALSE\n`);
  openssl(
    folder,
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'leaf.pem',
    '-days',
    '2',
    '-extfile',
    'leaf.cnf',
  );
  return {
    certificate: readFileSync(join(folder, 'leaf.pem'), 'utf8'),
    key: readFileSync(join(folder, 'leaf.key'), 'utf8'),
  };
}

const origin = authorityNamed('origin');
const clients = authorityNamed('clients');
const impostor = authorityNamed('impostor');
const generator = signedBy(clients, 'DNS:generator.test');

/** A server that answers only a client certificate `clients` signed, with the certificate it is given. */
function startOrigin(serving: { certificate: string; key: string }): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(
      {
        cert: serving.certificate,
        key: serving.key,
        ca: clients.certificate,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (_request, response) => response.end('origin'),
    );
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const portOf = (server: Server) => (server.address() as AddressInfo).port;

const original = getGlobalDispatcher();
let servers: Server[] = [];

beforeAll(() => {
  servers = [];
});

afterAll(() => {
  setGlobalDispatcher(original);
  for (const server of servers) server.close();
});

async function reached(
  serving: { certificate: string; key: string },
  trusting: string,
): Promise<string> {
  const server = await startOrigin(serving);
  servers.push(server);
  takeDirectPath(
    { originAddress: '127.0.0.1', certificate: generator.certificate, key: generator.key },
    trusting,
  );
  const response = await fetch(`https://${HOSTNAME}:${portOf(server)}/`);
  return response.text();
}

describe('takeDirectPath', () => {
  it('reaches an origin whose certificate the trusted authority signed, presenting its own client certificate', async () => {
    const certificate = signedBy(origin, `DNS:${HOSTNAME}`);

    expect(await reached(certificate, origin.certificate)).toBe('origin');
  });

  it('refuses a load balancer whose certificate another authority signed', async () => {
    const certificate = signedBy(impostor, `DNS:${HOSTNAME}`);

    await expect(reached(certificate, origin.certificate)).rejects.toThrow();
  });

  it('refuses a certificate the trusted authority signed for another name', async () => {
    const certificate = signedBy(origin, 'DNS:other.example.test');

    await expect(reached(certificate, origin.certificate)).rejects.toThrow();
  });

  it('refuses a certificate that is not signed by any authority, as a self-signed one', async () => {
    const selfSigned = { certificate: impostor.certificate, key: impostor.key };

    await expect(reached(selfSigned, origin.certificate)).rejects.toThrow();
  });

  it('trusts Cloudflare’s Origin CA by default, and so refuses an origin another authority signed', async () => {
    const certificate = signedBy(origin, `DNS:${HOSTNAME}`);
    const server = await startOrigin(certificate);
    servers.push(server);
    takeDirectPath({
      originAddress: '127.0.0.1',
      certificate: generator.certificate,
      key: generator.key,
    });

    await expect(fetch(`https://${HOSTNAME}:${portOf(server)}/`)).rejects.toThrow();
  });
});

describe('the authority the generator trusts by default', () => {
  it('is Cloudflare’s Origin CA, and is valid for at least another year, so that a run is not turned away by an expired pin', () => {
    const pinned = new X509Certificate(CLOUDFLARE_ORIGIN_CA);
    const aYearFromNow = Date.now() + 365 * 24 * 60 * 60 * 1_000;

    expect(pinned.subject).toContain('CloudFlare Origin SSL Certificate Authority');
    expect(Date.parse(pinned.validTo)).toBeGreaterThan(aYearFromNow);
  });
});
