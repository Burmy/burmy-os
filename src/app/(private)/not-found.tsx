import Link from 'next/link';

export default function PrivateNotFound(): React.ReactElement {
  return (
    <div className="mx-auto max-w-md py-16">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
        That page does not exist. Burmy is deliberately small — there is Finance
        and there is Settings.
      </p>
      <Link
        href="/finance/monthly"
        className="mt-6 inline-block text-sm underline underline-offset-4"
      >
        Back to the monthly grid
      </Link>
    </div>
  );
}
