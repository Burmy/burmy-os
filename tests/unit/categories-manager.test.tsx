import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The first component tests in the repository.
 *
 * They run in the `components` Vitest project (jsdom + jest-dom + RTL cleanup),
 * selected automatically by the `.test.tsx` extension — see vitest.config.ts for
 * why the split exists.
 *
 * Server Actions are mocked. What is under test is the REORDER INTERACTION: which
 * buttons exist, when they are disabled, and what payload the server is asked for.
 * That the server then renumbers densely and owner-scopes the write is asserted in
 * tests/integration/categories.test.ts against a real database — mocking that here
 * would only prove the mock was called.
 */

const reorderCategoriesAction = vi.fn(async () => ({ ok: true as const }));
const archiveCategoryAction = vi.fn(async () => ({ ok: true as const }));
const restoreCategoryAction = vi.fn(async () => ({ ok: true as const }));
const createCategoryAction = vi.fn(async () => ({ ok: true as const }));
const updateCategoryAction = vi.fn(async () => ({ ok: true as const }));
const deleteCategoryAction = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/features/finance/settings/category-actions', () => ({
  reorderCategoriesAction,
  archiveCategoryAction,
  restoreCategoryAction,
  createCategoryAction,
  updateCategoryAction,
  deleteCategoryAction,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { CategoriesManager } = await import('@/features/finance/settings/categories-manager');

type Category = Parameters<typeof CategoriesManager>[0]['live'][number];

function category(name: string, sortOrder: number, archived = false): Category {
  return {
    id: `00000000-0000-4000-8000-${String(sortOrder).padStart(12, '0')}`,
    name,
    slug: name.toLowerCase(),
    kind: 'spending',
    sortOrder,
    archivedAt: archived ? new Date('2026-01-01') : null,
  };
}

const LIVE = [category('Mortgage', 0), category('Gas', 1), category('Food', 2)];

beforeEach(() => {
  reorderCategoriesAction.mockClear();
  deleteCategoryAction.mockClear();
});

describe('CategoriesManager — reorder controls', () => {
  it('renders a category per row with its kind', () => {
    render(<CategoriesManager live={LIVE} archived={[]} transactionCounts={{}} />);

    expect(screen.getByText('Mortgage')).toBeInTheDocument();
    expect(screen.getByText('Gas')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('gives every row keyboard-reachable, labelled move buttons', () => {
    // The reason drag-and-drop was rejected: these are accessible by
    // construction, with no bespoke keyboard handling to get wrong.
    render(<CategoriesManager live={LIVE} archived={[]} transactionCounts={{}} />);

    for (const name of ['Mortgage', 'Gas', 'Food']) {
      expect(screen.getByRole('button', { name: `Move ${name} up` })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `Move ${name} down` })).toBeInTheDocument();
    }
  });

  it('disables "up" on the first row and "down" on the last', () => {
    render(<CategoriesManager live={LIVE} archived={[]} transactionCounts={{}} />);

    expect(screen.getByRole('button', { name: 'Move Mortgage up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Food down' })).toBeDisabled();

    // ...and the middle row can move both ways.
    expect(screen.getByRole('button', { name: 'Move Gas up' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move Gas down' })).toBeEnabled();
  });

  it('sends the FULL reordered id list, not a "move" instruction', () => {
    // Sending "move X up" per click would let interleaved requests produce
    // duplicate sort orders. One dense list per request cannot.
    render(<CategoriesManager live={LIVE} archived={[]} transactionCounts={{}} />);

    return userEvent
      .click(screen.getByRole('button', { name: 'Move Gas up' }))
      .then(async () => {
        await waitFor(() => expect(reorderCategoriesAction).toHaveBeenCalledTimes(1));

        expect(reorderCategoriesAction).toHaveBeenCalledWith([
          LIVE[1]?.id,
          LIVE[0]?.id,
          LIVE[2]?.id,
        ]);
      });
  });

  it('moves a row down by one position', async () => {
    render(<CategoriesManager live={LIVE} archived={[]} transactionCounts={{}} />);

    await userEvent.click(screen.getByRole('button', { name: 'Move Mortgage down' }));

    await waitFor(() => expect(reorderCategoriesAction).toHaveBeenCalledTimes(1));
    expect(reorderCategoriesAction).toHaveBeenCalledWith([
      LIVE[1]?.id,
      LIVE[0]?.id,
      LIVE[2]?.id,
    ]);
  });

  it('shows the new order immediately, before the server responds', async () => {
    // `useOptimistic`: the preview is what makes repeated clicks feel responsive.
    let release: (() => void) | undefined;
    reorderCategoriesAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true as const });
        }),
    );

    render(<CategoriesManager live={LIVE} archived={[]} transactionCounts={{}} />);

    // Mortgage, Gas, Food → move Food up → Mortgage, Food, Gas.
    await userEvent.click(screen.getByRole('button', { name: 'Move Food up' }));

    await waitFor(() => {
      const labels = screen
        .getAllByRole('button', { name: /^Move .* up$/ })
        .map((button) => button.getAttribute('aria-label'));

      expect(labels).toEqual(['Move Mortgage up', 'Move Food up', 'Move Gas up']);
    });

    release?.();
  });
});

describe('CategoriesManager — archive', () => {
  it('offers archive on every live category', () => {
    render(<CategoriesManager live={LIVE} archived={[]} transactionCounts={{}} />);

    expect(screen.getByRole('button', { name: 'Archive Mortgage' })).toBeInTheDocument();
  });

  it('lists archived categories separately, with restore', () => {
    render(
      <CategoriesManager
        live={LIVE}
        archived={[category('Old Travel', 9, true)]}
        transactionCounts={{}}
      />,
    );

    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.getByText('Old Travel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /restore/i })).toBeInTheDocument();
  });

  it('hides the archived section entirely when there is nothing archived', () => {
    render(<CategoriesManager live={LIVE} archived={[]} transactionCounts={{}} />);
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();
  });

  it('explains that archived names are free to reuse', () => {
    // The partial unique index allows it, and the owner has no way to know that
    // unless the UI says so.
    render(
      <CategoriesManager
        live={LIVE}
        archived={[category('Old Travel', 9, true)]}
        transactionCounts={{}}
      />,
    );
    expect(screen.getByText(/free to\s+reuse/i)).toBeInTheDocument();
  });
});

describe('CategoriesManager — delete', () => {
  it('disables delete for a category with transaction history, and explains why', () => {
    render(
      <CategoriesManager
        live={LIVE}
        archived={[]}
        transactionCounts={{ [LIVE[0]!.id]: 3 }}
      />,
    );

    const deleteButton = screen.getByRole('button', { name: 'Delete Mortgage' });
    expect(deleteButton).toBeDisabled();
    expect(deleteButton).toHaveAttribute('title', expect.stringContaining('archive'));
  });

  it('deletes a category with no transactions after confirming', async () => {
    render(<CategoriesManager live={LIVE} archived={[]} transactionCounts={{}} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Mortgage' }));
    expect(screen.getByText('Delete "Mortgage"?')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteCategoryAction).toHaveBeenCalledWith(LIVE[0]!.id));
  });
});

describe('CategoriesManager — empty state', () => {
  it('says so rather than rendering an empty list', () => {
    render(<CategoriesManager live={[]} archived={[]} transactionCounts={{}} />);
    expect(screen.getByText('No categories yet.')).toBeInTheDocument();
  });
});
