import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusBadge } from '@/components/games/status-badge';
import { GAME_STATUSES, STATUS_LABELS } from '@/server/games/taxonomy';
import type { GameStatus } from '@/server/games/taxonomy';

const VISIBLE_STATUSES = GAME_STATUSES.filter(
  (status): status is Exclude<GameStatus, 'played' | 'playing'> => status !== 'played' && status !== 'playing',
);

describe('StatusBadge', () => {
  /**
   * `played` is the invisible default (see `GAME_STATUSES` in taxonomy.ts) —
   * a played game is the overwhelmingly common case (171 of 180 real games)
   * and gets no badge at all, in EITHER variant. This is the entire point of
   * the status model, not an edge case.
   */
  it('renders nothing for a played game, default variant', () => {
    const { container } = render(<StatusBadge status="played" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a played game, onImage variant', () => {
    const { container } = render(<StatusBadge status="played" variant="onImage" />);
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * `playing` lost its distinct badge (and hero-card sizing, and sort-pin —
   * see `library-view.tsx`) — it now renders identically to `played`: no
   * badge in either variant.
   */
  it('renders nothing for a playing game, default variant', () => {
    const { container } = render(<StatusBadge status="playing" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a playing game, onImage variant', () => {
    const { container } = render(<StatusBadge status="playing" variant="onImage" />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(VISIBLE_STATUSES)('renders a real badge with the right label for %s, default variant', (status) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(STATUS_LABELS[status])).toBeInTheDocument();
  });

  it.each(VISIBLE_STATUSES)('renders a real badge with the right label for %s, onImage variant', (status) => {
    render(<StatusBadge status={status} variant="onImage" />);
    expect(screen.getByText(STATUS_LABELS[status])).toBeInTheDocument();
  });
});
