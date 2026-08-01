/**
 * Row selection arithmetic for `<DataTable>`, kept apart from the component.
 *
 * This is a plain `.ts` module rather than an export from `data-table.tsx`
 * because the file extension picks the vitest project: `selection.test.ts`
 * belongs to the **node** project, and a node test importing a `.tsx` module
 * would drag React and jsdom into an environment that has neither. Nothing
 * here touches React, so the rules below are provable without rendering --
 * which matters more than usual, since four phases consume this table.
 */

/**
 * Select or clear **only the rows on the current page**.
 *
 * The whole point of the function: `selected` may carry ids from pages the
 * operator has since navigated away from, and those must survive untouched.
 * Selecting rows nobody has seen is how a bulk delete removes more than the
 * operator meant to -- so the header checkbox never reaches beyond `pageIds`.
 *
 * A *partial* page selection counts as "select all", matching every other
 * table an operator has used: the second click on a half-ticked box fills it
 * rather than emptying it.
 */
export function toggleAll(pageIds: string[], selected: string[]): string[] {
  const alreadySelected = new Set(selected);
  // `every` is vacuously true for an empty page; the length guard keeps an
  // empty page from clearing a selection made elsewhere.
  const wholePageSelected = pageIds.length > 0 && pageIds.every((id) => alreadySelected.has(id));

  if (wholePageSelected) {
    const onThisPage = new Set(pageIds);
    return selected.filter((id) => !onThisPage.has(id));
  }

  // Append rather than rebuild, so ids from other pages keep both their
  // membership and their order.
  return [...selected, ...pageIds.filter((id) => !alreadySelected.has(id))];
}

/** Add `id` to the selection, or drop it if it is already there. */
export function toggleRow(id: string, selected: string[]): string[] {
  return selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id];
}
