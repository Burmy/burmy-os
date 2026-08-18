import { redirect } from 'next/navigation';

/**
 * Importing now happens through the Sheet on `/finance/monthly` ("+ Import
 * statement"), which absorbs what this page used to show — the upload form
 * and the in-progress ("Resume") list both live in the Sheet's opening
 * state now. This route stays only so an old bookmark or link still lands
 * somewhere real.
 */
export default function ImportPage(): never {
  redirect('/finance/monthly');
}
