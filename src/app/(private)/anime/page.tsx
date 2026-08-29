import { redirect } from 'next/navigation';

export default function AnimePage(): never {
  redirect('/anime/library');
}
