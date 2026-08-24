import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { type PlayYearDraft, PlayYearsPanel } from '@/features/games/library/play-years-panel';

function setup(value: PlayYearDraft[], totalTenths: number) {
  const onChange = vi.fn();
  render(<PlayYearsPanel value={value} onChange={onChange} totalTenths={totalTenths} />);
  return { onChange };
}

describe('PlayYearsPanel', () => {
  it('shows no rows and no warning when the split is empty', () => {
    setup([], 490);
    expect(screen.queryByLabelText(/year/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('adds a row when the add control is used', async () => {
    const user = userEvent.setup();
    const { onChange } = setup([], 490);

    await user.click(screen.getByRole('button', { name: /add a year/i }));

    expect(onChange).toHaveBeenCalledWith([{ year: '', hours: '' }]);
  });

  it('warns when the split does not add up to the total', () => {
    setup([{ year: '2024', hours: '37' }, { year: '2025', hours: '12' }], 510);

    expect(screen.getByRole('alert')).toHaveTextContent(/2h/);
  });

  it('shows no warning when the split matches the total exactly', () => {
    setup([{ year: '2024', hours: '37' }, { year: '2025', hours: '12' }], 490);

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns when the split overshoots the total', () => {
    setup([{ year: '2024', hours: '60' }], 490);

    expect(screen.getByRole('alert')).toHaveTextContent(/over/i);
  });

  it('removes the row the owner asked to remove, not the last one', async () => {
    const user = userEvent.setup();
    const { onChange } = setup([{ year: '2024', hours: '37' }, { year: '2025', hours: '12' }], 490);

    await user.click(screen.getAllByRole('button', { name: /remove/i })[0]!);

    expect(onChange).toHaveBeenCalledWith([{ year: '2025', hours: '12' }]);
  });
});
