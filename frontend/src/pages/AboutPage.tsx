export default function AboutPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md space-y-3 text-center">
        <h1 className="text-lg font-semibold text-foreground">About</h1>
        <p className="text-muted-foreground">
          A self-hosted AI chatbot with real-time streaming responses, long-term memory that
          remembers facts about you across conversations, and per-message cost observability.
        </p>
      </div>
    </div>
  );
}
