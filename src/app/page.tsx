import { redirect } from 'next/navigation';

/**
 * The monthly grid IS the landing experience.
 *
 * There is no Home dashboard in V1 — it was explicitly cut. The category x
 * month grid is what the owner opens, so it is what `/` resolves to.
 */
export default function RootPage(): never {
  redirect('/finance/monthly');
}
