import type { ActionFunctionArgs } from 'react-router';

type ActionProps = ActionFunctionArgs;

/**
 * Settled result consumed by AppLayout: `ok === false` raises the bottom
 * toast; `queued` means the backend accepted the titling and the title
 * arrives through the push channel, and `threadId` lets the loading pulse
 * stay lit for that thread until the title lands. `errorCode` comes from
 * the backend contract and is mapped to friendly copy there
 * (services/errorCodes) — raw provider details never reach the browser.
 */
export type GenerateTitleActionResult =
  | { ok: true; queued?: boolean; threadId?: string }
  | { ok: false; errorCode?: string };

export async function action({ params, request }: ActionProps): Promise<GenerateTitleActionResult> {
  const { threadId } = params;
  if (!threadId) throw new Response('Missing threadId', { status: 400 });

  // The regenerate button submits `forced=true`, which tells the backend to
  // title from the thread's first segment instead of its first exchange.
  const formData = await request.formData();
  const forced = formData.get('forced') === 'true';

  // Never throw from a fetch result: even if the backend is briefly down,
  // the fetcher must settle so the loading pulse stops and loaders
  // revalidate. A hard fetch failure is surfaced as a generic toast instead.
  const res = await fetch(`/api/threads/${threadId}/generate-title`, {
    method: 'POST',
    ...(forced
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ forced: true }),
        }
      : {}),
  }).catch(() => null);

  if (!res) return { ok: false, errorCode: 'internal_error' };
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { errorCode?: string } | null;
    return { ok: false, errorCode: body?.errorCode };
  }
  // The backend queues the titling and answers 202 at once; the title
  // itself lands through the push channel (or the next refetch).
  const body = (await res.json().catch(() => null)) as { queued?: boolean } | null;
  if (body?.queued === true) return { ok: true, queued: true, threadId };
  return { ok: true };
}
