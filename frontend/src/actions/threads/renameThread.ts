import { renameThread } from '@/services/api';
import type { ActionFunctionArgs } from 'react-router';

type Props = ActionFunctionArgs;

/**
 * Manual rename action. Returning `null` revalidates the root threads loader,
 * which is what refreshes the sidebar. A blank title or a server rejection
 * simply keeps the current name — the revalidation restores it.
 */
export async function action({ params, request }: Props) {
  if (!params.threadId) return null;

  const form = await request.formData();
  const title = String(form.get('title') ?? '');
  if (title.trim().length === 0) return null;

  try {
    await renameThread(params.threadId, title);
  } catch {
    // Server rejected the title (e.g. too long); keep the existing one.
  }
  return null;
}
