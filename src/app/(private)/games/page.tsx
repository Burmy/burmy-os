import { redirect } from 'next/navigation';

/** `/games` has no content of its own — the library is the landing view. */
export default function GamesIndexPage(): never {
  redirect('/games/library');
}
