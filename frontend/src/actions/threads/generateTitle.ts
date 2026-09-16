type ActionProps = {
  params: { threadId?: string };
  request: Request;
};

/**
 * Settled result consumed by AppLayout: `ok === false` raises the bottom
 * toast. `errorCode` comes from the backend contract and is mapped to
 * friendly copy there (services/errorCodes) — raw provider details never
 * reach the browser.
 */
export type GenerateTitleActionResult =
  | { ok: true; forced: boolean }
  | { ok: false; forced: boolean; errorCode?: string };

export async function action({ params, request }: ActionProps): Promise<GenerateTitleActionResult> {
  const { threadId } = params;
  if (!threadId) throw new Response('Missing threadId', { status: 400 });

  // Manual "Regenerate Title" submits `force`; the automatic flow after a new
  // chat's first exchange submits plain `{ threadId }`.
  const form = await request.formData().catch(() => new FormData());
  const forced = form.get('force') === 'true';

  // Never throw from a fetch result: even if the backend is briefly down (or
  // the titling call times out), the fetcher must settle so the loading pulse
  // stops and loaders revalidate the settled title. A hard fetch failure is
  // surfaced as a generic toast instead.
  const res = await fetch(`/api/threads/${threadId}/generate-title`, {
    method: 'POST',
    ...(forced
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        }
      : {}),
  }).catch(() => null);

  if (!res) return { ok: false, forced, errorCode: 'internal_error' };
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { errorCode?: string } | null;
    return { ok: false, forced, errorCode: body?.errorCode };
  }
  return { ok: true, forced };
}
