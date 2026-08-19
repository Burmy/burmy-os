/**
 * One shared "nothing here" shape for finance tables/lists. A `div`, not a
 * `p` — most callers only ever pass plain text, but the import picker's
 * empty-account state needs a button inside it too, and a block element
 * inside a `<p>` is invalid HTML.
 */
export function EmptyState({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <div className="text-muted-foreground py-8 text-center text-sm">{children}</div>;
}
