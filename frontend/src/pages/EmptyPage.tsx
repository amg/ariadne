export default function EmptyPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
      <img src="/logo-mark.svg" alt="" className="mb-3 h-12 w-12" />
      <h1 className="text-2xl font-semibold text-foreground">Ari</h1>
      <p>Create a chat to get started.</p>
    </div>
  );
}
