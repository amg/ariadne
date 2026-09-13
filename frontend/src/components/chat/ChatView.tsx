import { MessageMetaRow } from '@/components/metadata';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Message, MessageUsage } from '@/services/api';
import { chatStatusText } from '@/services/utils';
import { Send, Square } from 'lucide-react';
import { useState } from 'react';

/** A single bubble line plus its metadata row (settled or streaming). */
export interface DisplayRow {
  id: string;
  message: Message;
  usage: MessageUsage | null;
  /** True while this assistant row is still being streamed. */
  streaming: boolean;
}

type Props = {
  rows: DisplayRow[];
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  errorMessage?: string | null;
  onSend: (content: string) => void;
  onStop: () => void;
};

export default function ChatView({ rows, status, errorMessage, onSend, onStop }: Props) {
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!input.trim() || busy) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="mx-auto flex h-full w-full max-w-[900px] flex-col">
        <ScrollArea className="flex-1 p-4">
          <div className="flex flex-col gap-4">
            {rows.map(({ id, message, usage, streaming }) => (
              <div key={id} className="flex max-w-[70%] flex-col">
                <div
                  className={`rounded-lg p-3 ${
                    message.role === 'user'
                      ? 'self-end bg-primary text-primary-foreground'
                      : 'self-start bg-muted text-foreground'
                  }`}
                >
                  {message.content}
                </div>
                {message.role === 'assistant' ? (
                  <MessageMetaRow
                    usage={usage}
                    status={streaming ? chatStatusText(status) : undefined}
                    showLatency={!streaming}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="border-t bg-background p-4">
          {errorMessage ? <p className="mb-2 text-sm text-red-400">{errorMessage}</p> : null}
          <form className="flex gap-2" onSubmit={handleSubmit}>
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Type your message..."
              className="flex-1"
            />
            {busy ? (
              <Button type="button" size="icon" variant="destructive" onClick={onStop}>
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!input.trim()}>
                <Send className="h-4 w-4" />
              </Button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
