type ActionProps = {
  params: { threadId?: string };
};

/**
 * Settled result consumed by AppLayout: `ok === false` raises the bottom
 * toast. `errorCode` comes from the backend contract and is mapped to
 * friendly copy there (services/errorCodes) — raw provider details never
 * reach the browser.
 */
export type GenerateTitleActionResult = { ok: true } | { ok: false; errorCode?: string };

export async function action({ params }: ActionProps): Promise<GenerateTitleActionResult> {
  const { threadId } = params;
  if (!threadId) throw new Response('Missing threadId', { status: 400 });

  // Never throw from a fetch result: even if the backend is briefly down (or
  // the titling call times out), the fetcher must settle so the loading pulse
  // stops and loaders revalidate the settled title. A hard fetch failure is
  // surfaced as a generic toast instead.
  const res = await fetch(`/api/threads/${threadId}/generate-title`, {
    method: 'POST',
  }).catch(() => null);

  if (!res) return { ok: false, errorCode: 'internal_error' };
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { errorCode?: string } | null;
    return { ok: false, errorCode: body?.errorCode };
  }
  return { ok: true };
}
