import { describe, expect, it } from 'vitest';
import { devConnections, gatewayAddressOf, loadAccountPassword, reachableFrom } from './devHost.ts';

const ROUTES = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t010017AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  'eth0\t000017AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
].join('\n');

describe('gatewayAddressOf', () => {
  it('reads the default route as a dotted address', () => {
    expect(gatewayAddressOf(ROUTES)).toBe('172.23.0.1');
  });

  it('is null when the table has no default route', () => {
    expect(
      gatewayAddressOf(
        ROUTES.split('\n')
          .slice(0, 1)
          .concat(ROUTES.split('\n')[2] ?? '')
          .join('\n'),
      ),
    ).toBeNull();
  });
});

describe('reachableFrom', () => {
  it('points a localhost URL at the host, keeping credentials, port and path', () => {
    expect(reachableFrom('postgres://postgres:pw@localhost:15432/chatbot', '172.23.0.1')).toBe(
      'postgres://postgres:pw@172.23.0.1:15432/chatbot',
    );
    expect(reachableFrom('http://127.0.0.1:3567', '172.23.0.1')).toBe('http://172.23.0.1:3567');
  });

  it('leaves another host alone', () => {
    expect(reachableFrom('postgres://u:p@db.internal:5432/x', '172.23.0.1')).toBe(
      'postgres://u:p@db.internal:5432/x',
    );
  });

  it('does not touch a password that merely contains localhost', () => {
    expect(reachableFrom('postgres://u:localhost@db.internal/x', '10.0.0.1')).toBe(
      'postgres://u:localhost@db.internal/x',
    );
  });
});

describe('devConnections', () => {
  it('reaches dev through the host', () => {
    expect(
      devConnections(
        { DATABASE_URL: 'postgres://u:p@localhost:15432/chatbot', PORT: '3001' },
        '172.23.0.1',
      ),
    ).toEqual({
      databaseUrl: 'postgres://u:p@172.23.0.1:15432/chatbot',
      authCoreUrl: 'http://172.23.0.1:3567',
      hostBackendUrl: 'http://172.23.0.1:3001',
    });
  });

  it('refuses a dev without a database', () => {
    expect(() => devConnections({}, 'localhost')).toThrow(/DATABASE_URL/);
  });
});

describe('loadAccountPassword', () => {
  it('prefers the environment over the file', () => {
    expect(
      loadAccountPassword({ LOAD_ACCOUNT_PASSWORD: 'a' }, { LOAD_ACCOUNT_PASSWORD: 'b' }),
    ).toBe('a');
    expect(loadAccountPassword({}, { LOAD_ACCOUNT_PASSWORD: 'b' })).toBe('b');
  });

  it('refuses to run without one', () => {
    expect(() => loadAccountPassword({}, {})).toThrow(/LOAD_ACCOUNT_PASSWORD/);
  });
});
