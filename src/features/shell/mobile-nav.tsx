'use client';

import { Menu } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Nav } from './nav';

/**
 * The mobile equivalent of `Sidebar` — same `Nav` link list, inside the same
 * Sheet primitive built for the import overlay rather than a second
 * drawer implementation.
 */
export function MobileNav(): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open navigation" className="size-8 md:hidden">
          <Menu className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 sm:max-w-64">
        <SheetHeader>
          <SheetTitle>Burmy</SheetTitle>
        </SheetHeader>
        <div className="px-3 py-3">
          <Nav onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
