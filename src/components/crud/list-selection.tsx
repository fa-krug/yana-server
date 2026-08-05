"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type ListSelectionContextValue = {
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
  pageIds: string[];
  setPageIds: (ids: string[]) => void;
};

const ListSelectionContext = createContext<ListSelectionContextValue | null>(null);

/**
 * Selection state lifted above a list page's `<Suspense>` boundary, so the
 * table's header (rendered immediately, outside it) and its body (rendered
 * once rows arrive, inside it) can share one `selected` array without either
 * owning it.
 *
 * A Client Component provider wrapping Server Component children is the
 * supported way to get data from a client ancestor to a client descendant that
 * has a Server Component in between (the page's own async data-fetching
 * component) -- passing a callback down as a prop cannot cross that gap, since
 * the descendant is constructed by the Server Component, not by this provider.
 *
 * `pageIds` starts empty and is filled in by the table body once real rows
 * exist (see `setPageIds` above); the header reads it in the meantime, where
 * `pageIds.length === 0` already reads as "checked: false, disabled" --
 * exactly the state a select-all checkbox should show before there is
 * anything on the page to select.
 *
 * **This component must never be given a `key` that changes with the list's
 * params**, tempting as that looks for "reset the selection on every search or
 * page change" (the behaviour every `*TableShell` had before the header/body
 * split, and still documents). Measured, not theoretical: a page's own
 * `<Suspense key={...params}>` around the *body* swaps cleanly, but doing the
 * same to this component -- a stateful Client Component sitting above that
 * boundary -- produced two live copies of the table side by side after a
 * search, one still on the old query and one on the new, neither ever
 * unmounting. `resetKey` is the fix that doesn't touch this component's
 * identity: pass the same string the page would otherwise have used as a key
 * (`JSON.stringify(params)`), and a change to it clears the selection during
 * render -- React's own pattern for "adjust state when a prop changes"
 * (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes) --
 * without remounting anything above the table body.
 *
 * The "previous value" `lastResetKey` is `useState`, not `useRef`: reading or
 * writing a ref during render is exactly the footgun this pattern would
 * otherwise look like, so React's own version of it
 * (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
 * compares against a second piece of state instead, and the project's
 * `react-hooks` lint rule enforces that -- reads on this file if the ref form
 * is used here again.
 */
export function ListSelectionProvider({
  children,
  resetKey,
}: {
  children: ReactNode;
  /** Selection and `pageIds` both clear when this changes. Omit to never reset. */
  resetKey?: string;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [pageIds, setPageIds] = useState<string[]>([]);
  const [lastResetKey, setLastResetKey] = useState(resetKey);

  if (resetKey !== undefined && resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setSelected([]);
    setPageIds([]);
  }

  return (
    <ListSelectionContext.Provider
      value={{ selected, onSelectedChange: setSelected, pageIds, setPageIds }}
    >
      {children}
    </ListSelectionContext.Provider>
  );
}

/** Thrown eagerly rather than left to a confusing null-property crash downstream. */
export function useListSelection(): ListSelectionContextValue {
  const ctx = useContext(ListSelectionContext);
  if (!ctx) {
    throw new Error("useListSelection must be used within a <ListSelectionProvider>");
  }
  return ctx;
}
