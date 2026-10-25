import { afterEach, describe, expect, it, vi } from 'vitest';
import { authOriginFor } from './authService';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authOriginFor', () => {
  it('keeps a request origin the app serves', () => {
    vi.stubEnv('CORS_ORIGINS', 'https://ari.example, https://staging.ari.example');
    expect(authOriginFor('https://staging.ari.example')).toBe('https://staging.ari.example');
  });

  it('falls back to the first served origin for an origin the app does not serve', () => {
    vi.stubEnv('CORS_ORIGINS', 'https://ari.example,https://staging.ari.example');
    expect(authOriginFor('https://attacker.example')).toBe('https://ari.example');
  });

  it('matches a served origin written with a trailing slash', () => {
    vi.stubEnv('CORS_ORIGINS', 'https://ari.example/,https://staging.ari.example/');
    expect(authOriginFor('https://staging.ari.example')).toBe('https://staging.ari.example');
    expect(authOriginFor('https://attacker.example')).toBe('https://ari.example');
  });

  it('falls back to the first served origin when the request names none', () => {
    vi.stubEnv('CORS_ORIGINS', 'https://ari.example');
    expect(authOriginFor(undefined)).toBe('https://ari.example');
  });

  it('falls back to the local origin when the app serves none', () => {
    vi.stubEnv('CORS_ORIGINS', undefined);
    expect(authOriginFor('https://attacker.example')).toBe('http://localhost:5173');
    expect(authOriginFor(undefined)).toBe('http://localhost:5173');
  });
});
