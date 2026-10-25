import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const REPO_ROOT = new URL('../../../../', import.meta.url);

/** The default-route gateway of a container, read from its route table; null when there is none. */
export function gatewayAddressOf(routeTable: string) {
  for (const line of routeTable.split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination === '00000000' && gateway !== undefined && gateway !== '00000000') {
      const bytes = Buffer.from(gateway, 'hex');
      return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
    }
  }
  return null;
}

/** The address dev's services answer on: this machine's own, or the host's when running in a container. */
export function hostAddress() {
  if (!existsSync('/.dockerenv')) return 'localhost';
  const gateway = gatewayAddressOf(readFileSync('/proc/net/route', 'utf8'));
  if (gateway === null) throw new Error('Could not find the host from inside the container');
  return gateway;
}

/** The URL with `localhost` or `127.0.0.1` replaced by the host's address; any other host stays. */
export function reachableFrom(url: string, host: string) {
  return url.replace(/(\/\/(?:[^@/]*@)?)(localhost|127\.0\.0\.1)(?=[:/]|$)/, `$1${host}`);
}

/** The settings dev's `.env` holds. */
export function readDevEnvFile() {
  return parseEnv(readFileSync(new URL('.env', REPO_ROOT), 'utf8'));
}

export function devConnections(
  envFile: Readonly<Record<string, string | undefined>>,
  host: string,
) {
  const databaseUrl = envFile.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not set in .env');
  }
  return {
    databaseUrl: reachableFrom(databaseUrl, host),
    authCoreUrl: reachableFrom(envFile.SUPERTOKENS_CONNECTION_URI ?? 'http://localhost:3567', host),
    hostBackendUrl: `http://${host}:${envFile.PORT ?? '3001'}`,
  };
}

/** The shared password of the load accounts; it lives in the environment or in dev's `.env`, never in the repo. */
export function loadAccountPassword(
  environment: Readonly<Record<string, string | undefined>>,
  envFile: Readonly<Record<string, string | undefined>>,
) {
  const password = environment.LOAD_ACCOUNT_PASSWORD || envFile.LOAD_ACCOUNT_PASSWORD;
  if (password === undefined || password === '') {
    throw new Error(
      'LOAD_ACCOUNT_PASSWORD is not set. Put it in the environment or in .env: the load accounts sign in with it.',
    );
  }
  return password;
}
