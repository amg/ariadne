import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageSquare, PlusCircle, Send } from 'lucide-react';
import { useEffect, useState } from 'react';

type Thread = { id: string; title: string; created_at: string };
type Message = { id: string; role: 'user' | 'assistant'; content: string; created_at: string };

const API_BASE = '/api';

function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');

  // Fetch threads on load
  useEffect(() => {
    fetch(`${API_BASE}/threads`)
      .then((res) => res.json())
      .then((data) => {
        setThreads(data);
        if (data.length > 0) setActiveThreadId(data[0].id);
      });
  }, []);

  // Fetch messages when active thread changes
  useEffect(() => {
    if (!activeThreadId) return;
    fetch(`${API_BASE}/threads/${activeThreadId}/messages`)
      .then((res) => res.json())
      .then((data) => setMessages(data));
  }, [activeThreadId]);

  const createThread = async () => {
    const res = await fetch(`${API_BASE}/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Chat' }),
    });
    const newThread = await res.json();
    setThreads([newThread, ...threads]);
    setActiveThreadId(newThread.id);
  };

  const sendMessage = async () => {
    if (!input.trim() || !activeThreadId) return;
    const content = input;
    setInput('');

    // Optimistic UI update
    const tempMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempMessage]);

    const res = await fetch(`${API_BASE}/threads/${activeThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    const data = await res.json();
    setMessages((prev) => [...prev, data.message]);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <aside className="flex w-64 flex-col border-r bg-muted/20 p-4">
        <Button onClick={createThread} className="mb-4 flex items-center gap-2">
          <PlusCircle className="h-4 w-4" /> New Chat
        </Button>
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-2">
            {threads.map((thread) => (
              <Button
                key={thread.id}
                variant={thread.id === activeThreadId ? 'secondary' : 'ghost'}
                className="justify-start gap-2"
                onClick={() => setActiveThreadId(thread.id)}
              >
                <MessageSquare className="h-4 w-4" />
                <span className="truncate">{thread.title}</span>
              </Button>
            ))}
          </div>
        </ScrollArea>
      </aside>

      <main className="flex flex-1 flex-col bg-background">
        {activeThreadId ? (
          <>
            <ScrollArea className="flex-1 p-4">
              <div className="flex flex-col gap-4">
                {messages.map((msg) => (
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
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendMessage();
                }}
              >
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
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            Select or create a chat to begin.
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
