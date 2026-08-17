'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

/**
 * Sign out.
 *
 * Goes through the Better Auth client, which POSTs to `/api/auth/sign-out` and
 * deletes the server-side session row — so this is genuine revocation, not just
 * dropping a cookie. A stateless token would still be honoured until it expired.
 */
export function SignOutButton(): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Sign out"
      disabled={pending}
      className="size-8"
      onClick={() => {
        startTransition(async () => {
          await authClient.signOut();
          router.replace('/sign-in');
        });
      }}
    >
      <LogOut className="size-4" />
    </Button>
  );
}
