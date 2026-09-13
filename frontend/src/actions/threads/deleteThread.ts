import { deleteThread } from '@/services/api';
import { type ActionFunctionArgs, redirect } from 'react-router';

type Props = ActionFunctionArgs;

/**
 * Deletes a thread. The caller sends `from` (its current location): if the
 * user was looking at the deleted thread we redirect home (the index loader
 * then lands on the newest surviving thread, or the empty page). Otherwise
 * we `return null` so the root threads loader revalidates and the sidebar
 * drops the row while the current view stays put.
 */
export async function action({ params, request }: Props) {
  if (!params.threadId) return null;

  const form = await request.formData();
  const from = String(form.get('from') ?? '');

  try {
    await deleteThread(params.threadId);
  } catch {
    // Server refused (unknown thread, etc.); revalidation restores reality.
    return null;
  }

  if (from === `/threads/${params.threadId}`) return redirect('/');
  return null;
}
