import { ChatController } from '@/components/chat';
import { type Message, fetchMessages } from '@/services/api';
import { useLoaderData, useRevalidator } from 'react-router';

/** Framework glue only: loader + revalidation. The exchange lives in
 *  components/chat/ChatController. See PK "Framework files" policy. */

type LoaderProps = { params: { threadId?: string } };

export async function loader({ params }: LoaderProps) {
  return {
    threadId: params.threadId ?? '',
    messages: params.threadId ? await fetchMessages(params.threadId) : [],
  };
}

export default function ChatPage() {
  const { threadId, messages: rows } = useLoaderData() as {
    threadId: string;
    messages: Message[];
  };
  const revalidator = useRevalidator();

  return (
    <ChatController threadId={threadId} rows={rows} onSettle={() => revalidator.revalidate()} />
  );
}
