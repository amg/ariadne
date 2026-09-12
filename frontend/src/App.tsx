import { MessageSquare, PlusCircle, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import './App.css';

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
    <div className="layout">
      <aside className="sidebar">
        <button className="new-chat-btn" onClick={createThread} type="button">
          <PlusCircle size={16} /> New Chat
        </button>
        <div className="thread-list">
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={`thread-item ${thread.id === activeThreadId ? 'active' : ''}`}
              onClick={() => setActiveThreadId(thread.id)}
              type="button"
            >
              <MessageSquare size={16} />
              {thread.title}
            </button>
          ))}
        </div>
      </aside>

      <main className="chat-area">
        {activeThreadId ? (
          <>
            <div className="message-list">
              {messages.map((msg) => (
                <div key={msg.id} className={`message-bubble ${msg.role}`}>
                  {msg.content}
                </div>
              ))}
            </div>
            <div className="input-area">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Type your message..."
              />
              <button onClick={sendMessage} type="button">
                <Send size={16} />
              </button>
            </div>
          </>
        ) : (
          <div className="empty-state">Select or create a chat to begin.</div>
        )}
      </main>
    </div>
  );
}

export default App;
