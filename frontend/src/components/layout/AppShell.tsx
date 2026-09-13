type AppShellProps = {
  sidebar: React.ReactNode;
  children: React.ReactNode;
};

export default function AppShell({ sidebar, children }: AppShellProps) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {sidebar}
      <main className="flex flex-1 flex-col bg-background">{children}</main>
    </div>
  );
}
