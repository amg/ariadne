import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Info, Menu } from 'lucide-react';
import { useEffect, useState } from 'react';

type Props = {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  infoPanel?: React.ReactNode;
  /** Changes on every navigation; the hamburger menu closes when it does. */
  navigationKey: string;
};

export default function AppShell({ sidebar, children, infoPanel, navigationKey }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigationKey is the trigger
  useEffect(() => {
    setMenuOpen(false);
  }, [navigationKey]);

  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-background text-foreground">
      {/* Desktop Sidebar */}
      <div className="hidden nav:block h-full">{sidebar}</div>

      <main className="flex min-w-0 flex-1 flex-col bg-background relative">
        {/* Mobile/Tablet Header */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-2 nav:hidden">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open sidebar">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0 bg-background">
              {sidebar}
            </SheetContent>
          </Sheet>

          <div className="flex-1" />

          {infoPanel && (
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Open info">
                  <Info className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-72 p-0 bg-background">
                {infoPanel}
              </SheetContent>
            </Sheet>
          )}
        </header>

        {children}
      </main>

      {/* Desktop Info Panel */}
      {infoPanel && <div className="hidden h-full nav:block">{infoPanel}</div>}
    </div>
  );
}
