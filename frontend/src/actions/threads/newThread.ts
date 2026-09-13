import { createThread } from '@/services/api';
import { redirect } from 'react-router';

export async function action() {
  const thread = await createThread('New Chat');
  return redirect(`/threads/${thread.id}`);
}
