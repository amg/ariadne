import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Message } from '@/lib/api';
import { Send } from 'lucide-react';
import { useState } from 'react';
import { useFetcher, useLoaderData } from 'react-router';

export default function ChatPage() {
  const { messages } = useLoaderData() as { messages: Message[] };
  const fetcher = useFetcher();
  const [input, setInput] = useState('');

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    fetcher.submit({ content: input }, { method: 'post' });
    setInput('');
  };

  return (
    <div className="flex flex-1 flex-col">
      <ScrollArea className="flex-1 p-4">
        <div className="flex flex-col gap-4">
          {displayMessages.map((msg) => (
            <div
              key={msg.id}
              className={`max-w-[70%] rounded-lg p-3 ${
                msg.role === 'user'
                  ? 'self-end bg-primary text-primary-foreground'
                  : 'self-start bg-muted text-foreground'
              }`}
            >
              {msg.content}
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="border-t bg-background p-4">
        <form className="flex gap-2" onSubmit={handleSubmit}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            className="flex-1"
          />
          <Button type="submit" size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
