/** One shared "nothing here" shape for finance tables/lists. */
export function EmptyState({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <p className="text-muted-foreground py-8 text-center text-sm">{children}</p>;
}
