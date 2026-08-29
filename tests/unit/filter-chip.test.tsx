import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FilterChip } from '@/components/ui/filter-chip';

/**
 * The shared filter chip, used by Finance, Games and Anime.
 *
 * The test that matters is the accessible name. An accessible name is computed
 * by concatenating child nodes with each one TRIMMED, so a label beside a count
 * span comes out "Watching2" — which reads wrong aloud and cannot be queried
 * by name. Found when a chip could not be selected in a browser check.
 */

describe('FilterChip', () => {
  it('separates the label from the count in the accessible name', () => {
    render(<FilterChip label="Watching" count={2} active={false} onClick={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Watching, 2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Watching2' })).not.toBeInTheDocument();
  });

  it('keeps the visible label as a prefix of the name', () => {
    // WCAG 2.5.3: a speech-input user says what they can see.
    render(<FilterChip label="Completed" count={4} active={false} onClick={vi.fn()} />);

    const chip = screen.getByRole('button', { name: /^Completed/ });
    expect(chip).toHaveTextContent('Completed');
  });

  it('uses the bare label when there is no count', () => {
    render(<FilterChip label="Wanted" active={false} onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Wanted' })).toBeInTheDocument();
  });

  it('carries its pressed state', () => {
    render(<FilterChip label="Dropped" count={1} active onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Dropped, 1' })).toHaveAttribute('aria-pressed', 'true');
  });
});
