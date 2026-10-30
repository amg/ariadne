import type { RestoredDraft } from '@/components/chat/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ComposerNotice } from './ComposerNotice';
import type { UnansweredArrival } from './types';

/**
 * The input and the line over it. `paused` locks the input while the user
 * chooses where a paused arrival continues. `restoredDraft` puts a failed
 * submit's text back in the input and focuses it. `onSent` runs after each
 * message is sent.
 */
export function Composer({
  busy,
  paused,
  restoredDraft,
  unansweredArrival,
  errorMessage,
  onSend,
  onStop,
  onRetryLast,
  onSent,
}: {
  busy: boolean;
  paused: boolean;
  restoredDraft: RestoredDraft | null | undefined;
  unansweredArrival: UnansweredArrival | null | undefined;
  errorMessage: string | null | undefined;
  onSend: (content: string) => void;
  onStop: () => void;
  onRetryLast: () => void;
  onSent: () => void;
}) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // The draft never dies on a failed submit: it returns to the input, and
  // recovery is a resend.
  useEffect(() => {
    if (!restoredDraft) return;
    // External system sync (the registry's failed-submit notification lands
    // in state, this writes it into the DOM input and focuses it) — the only
    // shape that can restore AND focus a live input element.
    // eslint-disable-next-line react/set-state-in-effect
    setInput(restoredDraft.text);
    inputRef.current?.focus();
  }, [restoredDraft]);

  const submit = () => {
    if (!input.trim() || busy || paused) return;
    onSend(input.trim());
    setInput('');
    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }
    onSent();
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter inserts a newline (default behavior); Enter alone sends the message.
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setInput(value);
    // Auto-grow the textarea up to max-h-[120px] (~5 lines)
    const textarea = event.target;
    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 120);
    textarea.style.height = `${newHeight}px`;
  };

  return (
    <div className="mx-auto w-full min-w-0 max-w-[900px] border-t bg-background p-4">
      <ComposerNotice
        unansweredArrival={unansweredArrival}
        errorMessage={errorMessage}
        onRetry={onRetryLast}
      />
      <form className="flex gap-2" onSubmit={handleSubmit}>
        <Textarea
          ref={inputRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            paused ? 'Choose where the last message continues first' : 'Type your message...'
          }
          className="flex-1 resize-none"
          rows={1}
          autoFocus
        />
        {busy ? (
          <Button type="button" size="icon" variant="destructive" onClick={onStop}>
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button type="submit" size="icon" disabled={!input.trim() || paused}>
            <Send className="h-4 w-4" />
          </Button>
        )}
      </form>
    </div>
  );
}
