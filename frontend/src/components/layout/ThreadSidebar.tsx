import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { Thread } from '@/lib/api';
import { MessageSquare, PlusCircle } from 'lucide-react';
import { Form, Link } from 'react-router';

type Props = {
  threads: Thread[];
  activeThreadId: string | null;
};

export default function ThreadSidebar({ threads, activeThreadId }: Props) {
  return (
    <aside className="flex w-64 flex-col border-r bg-muted/20 p-4">
      <Form method="post" action="/threads/new" className="mb-4">
        <Button type="submit" className="flex w-full items-center gap-2">
          <PlusCircle className="h-4 w-4" /> New Chat
        </Button>
      </Form>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2">
          {threads.map((thread) => (
            <Button
              key={thread.id}
              asChild
              variant={thread.id === activeThreadId ? 'secondary' : 'ghost'}
              className="justify-start gap-2"
            >
              <Link to={`/threads/${thread.id}`}>
                <MessageSquare className="h-4 w-4" />
                <span className="truncate">{thread.title}</span>
              </Link>
            </Button>
          ))}
        </div>
      </ScrollArea>
    </aside>
  );
}
