import ChatView from '@/components/chat/ChatView';
import { type Message, fetchMessages } from '@/services/api';
import { useFetcher, useLoaderData } from 'react-router';

type LoaderProps = { params: { threadId?: string } };

export async function loader({ params }: LoaderProps) {
  return { messages: params.threadId ? await fetchMessages(params.threadId) : [] };
}

// Framework entry: reads router state, then delegates straight to the pure UI.
export default function ChatPage() {
  const { messages } = useLoaderData() as { messages: Message[] };
  const fetcher = useFetcher();

  const pendingContent = fetcher.formData?.get('content');
  const displayMessages: Message[] = pendingContent
    ? [
        ...messages,
        {
          id: 'optimistic',
          role: 'user',
          content: String(pendingContent),
          created_at: new Date().toISOString(),
        },
      ]
    : messages;

  return (
    <ChatView
      messages={displayMessages}
      sending={fetcher.state !== 'idle'}
      onSend={(content) => fetcher.submit({ content }, { method: 'post' })}
    />
  );
}
