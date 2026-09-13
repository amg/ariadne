import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Message } from '@/services/api';
import { Send } from 'lucide-react';
import { useState } from 'react';

type ChatViewProps = {
  messages: Message[];
  sending: boolean;
  onSend: (content: string) => void;
};

export default function ChatView({ messages, sending, onSend }: ChatViewProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!input.trim() || sending) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div className="flex flex-1 flex-col">
      <ScrollArea className="flex-1 p-4">
        <div className="flex flex-col gap-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`max-w-[70%] rounded-lg p-3 ${
                message.role === 'user'
                  ? 'self-end bg-primary text-primary-foreground'
                  : 'self-start bg-muted text-foreground'
              }`}
            >
              {message.content}
            </div>
          ))}
        </div>
      </ScrollArea>
      <div className="border-t bg-background p-4">
        <form className="flex gap-2" onSubmit={handleSubmit}>
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type your message..."
            className="flex-1"
            disabled={sending}
          />
          <Button type="submit" size="icon" disabled={sending}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
