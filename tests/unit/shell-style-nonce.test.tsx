import { render } from '@testing-library/react';
import { getNonce } from 'get-nonce';
import { describe, expect, it } from 'vitest';

import { StyleNonce } from '@/features/shell/style-nonce';

/**
 * The nonce Radix's style injector uses must be the one the DOCUMENT was served
 * with. A Server Action's `revalidatePath` re-renders the root layout with a
 * fresh per-request nonce; adopting it would make every `<style>` Radix injects
 * afterwards (a dialog's scroll lock, say) mismatch the CSP header the page
 * still carries — found in a real browser: the Remove-game confirm reported
 * `style-src-elem` violations after any field save, and never before one.
 */
describe('StyleNonce', () => {
  it('keeps the first nonce for the life of the document, ignoring later re-renders', () => {
    const { rerender } = render(<StyleNonce nonce="first-nonce" />);
    expect(getNonce()).toBe('first-nonce');

    rerender(<StyleNonce nonce="refreshed-nonce" />);
    expect(getNonce()).toBe('first-nonce');
  });
});
