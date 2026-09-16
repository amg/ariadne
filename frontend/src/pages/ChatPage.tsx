import { ChatController } from '@/components/chat';
import { type Message, TITLE_GENERATING_SENTINEL, fetchMessages } from '@/services/api';
import type { Thread } from '@/services/api';
import { useLoaderData, useOutletContext, useRevalidator, useRouteLoaderData } from 'react-router';

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
  const { threads } = useRouteLoaderData('root') as { threads: Thread[] };
  const revalidator = useRevalidator();

  const title = threads?.find((t) => t.id === threadId)?.title;
  const { generateTitle } = useOutletContext<{ generateTitle: (id: string) => void }>();

  return (
    <ChatController
      threadId={threadId}
      rows={rows}
      onSettle={() => revalidator.revalidate()}
      isNewChat={title === TITLE_GENERATING_SENTINEL}
      onGenerateTitle={() => generateTitle(threadId)}
    />
  );
}
