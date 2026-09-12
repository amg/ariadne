import cors from '@fastify/cors';
import Fastify from 'fastify';
import { db } from './db/db';

const app = Fastify({ logger: true });

app.register(cors, { origin: true });

// Hardcoded user ID for MVP
const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

app.get('/api/health', async (_request, reply) => {
  return reply.send({ status: 'ok', message: 'Chatbot API is running' });
});

app.get('/api/threads', async (_request, reply) => {
  const threads = await db
    .selectFrom('threads')
    .selectAll()
    .where('user_id', '=', DEFAULT_USER_ID)
    .orderBy('created_at', 'desc')
    .execute();
  return reply.send(threads);
});

app.post('/api/threads', async (request, reply) => {
  const body = request.body as { title: string };
  const thread = await db
    .insertInto('threads')
    .values({
      user_id: DEFAULT_USER_ID,
      title: body.title || 'New Chat',
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return reply.send(thread);
});

app.get('/api/threads/:id/messages', async (request, reply) => {
  const { id } = request.params as { id: string };
  const messages = await db
    .selectFrom('messages')
    .selectAll()
    .where('thread_id', '=', id)
    .orderBy('created_at', 'asc')
    .execute();
  return reply.send(messages);
});

// A simple mock for chat (no AI yet, just echoing)
app.post('/api/threads/:id/messages', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { content } = request.body as { content: string };

  // Save User Message
  await db
    .insertInto('messages')
    .values({
      thread_id: id,
      role: 'user',
      content: content,
    })
    .execute();

  // Mock AI Response
  const aiContent = `Echo: ${content}`;

  // Save AI Message
  const aiMessage = await db
    .insertInto('messages')
    .values({
      thread_id: id,
      role: 'assistant',
      content: aiContent,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // We simply return the message json for now instead of complex SSE stream
  // This will be swapped out when we add Vercel AI SDK
  return reply.send({ message: aiMessage });
});

async function seedDefaultUser() {
  const user = await db.selectFrom('users').where('id', '=', DEFAULT_USER_ID).executeTakeFirst();
  if (!user) {
    await db.insertInto('users').values({ id: DEFAULT_USER_ID }).execute();
    console.log('Seeded default user');
  }
}

const start = async () => {
  try {
    await seedDefaultUser();
    await app.listen({ port: 3001, host: '0.0.0.0' });
    console.log('Server is running on http://localhost:3001');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
