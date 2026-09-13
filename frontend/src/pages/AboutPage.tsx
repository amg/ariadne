const STACK: { label: string; items: string }[] = [
  {
    label: 'Frontend',
    items: 'React 19 · React Router 7 data router · Vite · Tailwind CSS · Radix UI',
  },
  {
    label: 'Backend',
    items: 'Node.js + TypeScript · Fastify · Kysely query builder · Vitest + Testcontainers',
  },
  {
    label: 'AI & data',
    items:
      'Vercel AI SDK (SSE streaming) · DeepInfra via OpenAI-compatible API · PostgreSQL + pgvector for RAG long-term memory',
  },
  {
    label: 'Infra',
    items: 'Docker / Docker Compose · self-hosted',
  },
];

export default function AboutPage() {
  return (
    <div className="flex flex-1 justify-center overflow-y-auto p-8">
      <div className="max-w-lg space-y-8">
        <div className="space-y-3">
          <h1 className="text-lg font-semibold text-foreground">About</h1>
          <p className="text-sm text-muted-foreground">
            A self-hosted AI chatbot with real-time streaming responses, long-term memory that
            remembers facts about you across conversations, and per-message cost observability.
          </p>
        </div>
        <div className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Stack
          </h2>
          <dl className="space-y-3 text-sm">
            {STACK.map(({ label, items }) => (
              <div key={label}>
                <dt className="font-medium text-foreground">{label}</dt>
                <dd className="text-muted-foreground">{items}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
