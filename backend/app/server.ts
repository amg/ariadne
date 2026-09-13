import cors from '@fastify/cors';
import { setupHealthRoute } from '@routes/health/get';
import { setupMessagesGetRoute, setupMessagesPostRoute } from '@routes/messages';
import {
  setupThreadsDeleteRoute,
  setupThreadsGetRoute,
  setupThreadsPatchRoute,
  setupThreadsPostRoute,
} from '@routes/threads';
import { seedDefaultUser } from '@services/userService';
import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.register(cors, { origin: true });

// Register routes
setupHealthRoute(app);
setupThreadsGetRoute(app);
setupThreadsPostRoute(app);
setupThreadsPatchRoute(app);
setupThreadsDeleteRoute(app);
setupMessagesGetRoute(app);
setupMessagesPostRoute(app);

const start = async () => {
  try {
    await seedDefaultUser();
    await app.listen({ port: 3001, host: '0.0.0.0' });
    console.log('Server is running on http://127.0.0.1:3001');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
