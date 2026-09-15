type Props = {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  infoPanel?: React.ReactNode;
};

export default function AppShell({ sidebar, children, infoPanel }: Props) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {sidebar}
      <main className="flex min-w-0 flex-1 flex-col bg-background">{children}</main>
      {infoPanel}
    </div>
  );
}
