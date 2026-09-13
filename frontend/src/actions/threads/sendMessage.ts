import { postMessage } from '@/services/api';

type SendMessageArgs = { params: { threadId?: string }; request: Request };

export async function action({ params, request }: SendMessageArgs) {
  const formData = await request.formData();
  const content = String(formData.get('content') ?? '').trim();
  if (!params.threadId || !content) return null;
  await postMessage(params.threadId, content);
  return null;
}
