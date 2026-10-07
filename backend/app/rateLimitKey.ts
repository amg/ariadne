import type { FastifyRequest } from 'fastify';
import Session from 'supertokens-node/recipe/session';

const ACCESS_TOKEN_COOKIE = 'sAccessToken';

/**
 * The bucket a request counts against: its signed-in user when the request
 * carries a valid session, otherwise its client address. Every request
 * reaches the backend through the same proxy, so without a session all
 * callers share one bucket.
 */
export async function rateLimitKey(request: FastifyRequest): Promise<string> {
  const userId = await signedInUserId(request);
  return userId === undefined ? `ip:${request.ip}` : `user:${userId}`;
}

/** The user a valid access token names; expired, forged or absent tokens name nobody. */
async function signedInUserId(request: FastifyRequest): Promise<string | undefined> {
  const accessToken = accessTokenOf(request);
  if (accessToken === undefined) return undefined;
  try {
    const session = await Session.getSessionWithoutRequestResponse(accessToken, undefined, {
      antiCsrfCheck: false,
    });
    return session.getUserId();
  } catch {
    return undefined;
  }
}

function accessTokenOf(request: FastifyRequest): string | undefined {
  const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer !== undefined) return bearer;
  return cookieValue(request.headers.cookie, ACCESS_TOKEN_COOKIE);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
