import { useState } from 'react';

export default function AboutPage() {
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  const toggleSection = (section: string) => {
    setExpandedSection(expandedSection === section ? null : section);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-slim">
      <div className="mx-auto max-w-4xl flex-1 px-6 py-8">
        <h1 className="text-2xl font-bold mb-6 text-foreground">About This Project</h1>

        <div className="space-y-8">
          <p className="text-base text-muted-foreground">
            A self-hosted AI chat application with advanced features for topic drift detection,
            memory management, and cost control. Built for personal deployment behind a tunnel.
          </p>

          <section>
            <h2 className="text-lg font-semibold mb-4 text-foreground">Core Features</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <FeatureCard
                title="Drift Gate"
                description="Pre-inference judgment of user messages to detect topic drift before generating responses. Can pause conversations when significant drift is detected."
              />
              <FeatureCard
                title="Memory System"
                description="Automatic fact extraction from conversations with duplicate detection. Facts are categorized and can be suppressed or managed."
              />
              <FeatureCard
                title="Cost Control"
                description="Daily spend budget with rate limiting. Detailed tracking of inference costs, embedding costs, and rewrite operations."
              />
              <FeatureCard
                title="Thread Management"
                description="Automatic thread titling, segment analysis, and conversation organization. Background processing ensures completion even after browser closes."
              />
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-4 text-foreground">Technology Stack</h2>
            <div className="rounded-lg border border-border bg-card p-6">
              <div className="grid gap-6 sm:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold mb-3 text-foreground">Backend</h3>
                  <ul className="space-y-2">
                    <TechItem name="Fastify" description="TypeScript HTTP server" />
                    <TechItem name="PostgreSQL" description="Primary database" />
                    <TechItem name="Kysely" description="Type-safe query builder" />
                    <TechItem name="Graphile Worker" description="Durable background job queue" />
                    <TechItem name="SuperTokens" description="Authentication system" />
                    <TechItem name="Pino" description="Logging framework" />
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-semibold mb-3 text-foreground">AI & Frontend</h3>
                  <ul className="space-y-2">
                    <TechItem name="DeepInfra" description="AI model provider" />
                    <TechItem name="AI SDK" description="Unified AI interface" />
                    <TechItem name="React" description="Frontend framework" />
                    <TechItem name="TypeScript" description="Type-safe development" />
                    <TechItem name="Server-Sent Events" description="Real-time server push" />
                  </ul>
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-4 text-foreground">Architecture Highlights</h2>

            <ArchitectureSection
              title="Durable Background Processing"
              content={
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>
                    Background work runs on{' '}
                    <strong className="text-foreground">Graphile Worker</strong> over PostgreSQL, in
                    its own
                    <code className="rounded bg-muted px-1 text-foreground">queues</code> schema.
                    This ensures work completes even if the browser closes or the backend restarts.
                  </p>
                  <p>
                    Tasks include drift gate judgment, thread titling, and memory fact capture. Each
                    task is idempotent and can be retried with exponential backoff. Failed tasks are
                    classified as recoverable (rate limits, timeouts) or fatal (missing
                    configuration, rejected credentials).
                  </p>
                </div>
              }
              isExpanded={expandedSection === 'background'}
              onToggle={() => toggleSection('background')}
            />

            <ArchitectureSection
              title="Event-Driven Server Push"
              content={
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>
                    An in-memory event bus carries news from background tasks to connected browsers.
                    The transport is swappable—currently using Server-Sent Events (SSE), but
                    WebSocket support can be added without changing event producers.
                  </p>
                  <p>
                    Events include verdict notifications, thread titles, and memory capture
                    completions. Each event is scoped to a user and thread, with fan-out per user
                    and filtering per screen.
                  </p>
                </div>
              }
              isExpanded={expandedSection === 'events'}
              onToggle={() => toggleSection('events')}
            />

            <ArchitectureSection
              title="Query-Based Data Access"
              content={
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>
                    Database queries are organized by table in a dedicated queries directory. Each
                    query is a self-contained function that can run on the app database or within a
                    transaction, ensuring writes that must commit together use the same handle.
                  </p>
                  <p>
                    Type-safe queries through Kysely with camelCase-to-snake_case mapping. The
                    database schema includes tables for users, threads, messages, embeddings,
                    segments, facts, and queue jobs.
                  </p>
                </div>
              }
              isExpanded={expandedSection === 'queries'}
              onToggle={() => toggleSection('queries')}
            />

            <ArchitectureSection
              title="Exchange Lifecycle Tracking"
              content={
                <div className="space-y-3 text-sm text-muted-foreground">
                  <p>
                    Every chat exchange is tracked through its lifecycle: pending while streaming,
                    completed when finished, interrupted if stopped intentionally, or error if
                    failed. This allows resumption and accurate cost tracking.
                  </p>
                  <p>
                    The system tracks inference telemetry including token usage, finish reasons, and
                    costs. Estimated costs are recorded locally when the provider doesn't report
                    usage (early exchange termination).
                  </p>
                </div>
              }
              isExpanded={expandedSection === 'exchange'}
              onToggle={() => toggleSection('exchange')}
            />
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-4 text-foreground">Deployment</h2>
            <div className="rounded-lg border border-border bg-muted/30 p-6">
              <p className="mb-4 text-sm text-muted-foreground">
                Designed for single-user deployment behind a tunnel (e.g., Cloudflare Tunnel,
                ngrok). The system assumes one backend instance and one user deployment.
              </p>
              <h3 className="text-sm font-semibold mb-3 text-foreground">Requirements</h3>
              <ul className="list-inside list-disc space-y-2 mb-4 text-sm text-muted-foreground">
                <li>PostgreSQL database</li>
                <li>DeepInfra API key for AI models</li>
                <li>SuperTokens configuration for authentication</li>
                <li>Node.js runtime (v18+)</li>
              </ul>
              <h3 className="text-sm font-semibold mb-3 text-foreground">Configuration</h3>
              <p className="text-sm text-muted-foreground">
                Environment variables control all aspects: database connection, AI models, feature
                toggles, spend budgets, and timeout thresholds. See the environment configuration
                for complete details.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-4 text-foreground">Design Principles</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <PrincipleCard
                title="Durability Over Speed"
                description="Background work survives restarts and closed browsers. Correctness rests on idempotent tasks and state-based execution."
              />
              <PrincipleCard
                title="Database as Authority"
                description="Push is a courtesy, not a record. Reconnects re-emit current state; nothing is replayed from history."
              />
              <PrincipleCard
                title="Swappable Transports"
                description="Event delivery mechanism is an adapter. Producers never know who is listening or how events travel."
              />
              <PrincipleCard
                title="Cost Transparency"
                description="Every inference operation is tracked and budgeted. Daily spend gates protect against runaway costs."
              />
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-4 text-foreground">Project Status</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              This is an active personal project with continuous development. Key areas of ongoing
              work:
            </p>
            <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
              <li>Domain schema migration for queue tasks</li>
              <li>Queue management interface for failed jobs</li>
              <li>Multi-replica deployment support (requires cross-process event bus)</li>
              <li>Automatic sweep for failed or owed work</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

interface FeatureCardProps {
  title: string;
  description: string;
}

function FeatureCard({ title, description }: FeatureCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-2 text-foreground">{title}</h3>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

interface TechItemProps {
  name: string;
  description: string;
}

function TechItem({ name, description }: TechItemProps) {
  return (
    <li className="flex items-center justify-between">
      <span className="font-medium text-foreground">{name}</span>
      <span className="text-sm text-muted-foreground">{description}</span>
    </li>
  );
}

interface ArchitectureSectionProps {
  title: string;
  content: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
}

function ArchitectureSection({ title, content, isExpanded, onToggle }: ArchitectureSectionProps) {
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between bg-muted/30 px-6 py-4 text-left transition-colors hover:bg-muted/50"
      >
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span className="text-muted-foreground">{isExpanded ? '−' : '+'}</span>
      </button>
      {isExpanded && <div className="px-6 py-4">{content}</div>}
    </div>
  );
}

interface PrincipleCardProps {
  title: string;
  description: string;
}

function PrincipleCard({ title, description }: PrincipleCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-2 text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
