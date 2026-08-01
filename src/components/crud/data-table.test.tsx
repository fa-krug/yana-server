import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import { DataTable, type Column } from "./data-table";

// The shared router stub, never an inline factory -- see the comment at the
// top of src/test/next-navigation.ts.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

type Row = { slug: string; name: string };

const rows: Row[] = [
  { slug: "a", name: "Ada" },
  { slug: "b", name: "Bob" },
  { slug: "c", name: "Cyd" },
];

// `slug`, not `id`, on purpose: `rowId` exists because tags and articles do not
// key on `id`, and a fixture with an `id` field would let a regression to
// `row.id` pass.
const columns: Column<Row>[] = [
  { key: "name", header: "Name", cell: (row) => row.name, sortable: true },
  { key: "slug", header: "Slug", cell: (row) => row.slug },
];

function renderTable(selected: string[], onSelectedChange = vi.fn()) {
  const result = renderWithProviders(
    <DataTable
      rows={rows}
      columns={columns}
      rowId={(row) => row.slug}
      selected={selected}
      onSelectedChange={onSelectedChange}
    />,
  );
  return { ...result, onSelectedChange };
}

/**
 * The header checkbox of a given render.
 *
 * Scoped to a container rather than to `screen`, because the three-state test
 * renders three tables into one document -- testing-library only cleans up
 * between tests, so a document-wide query would keep answering with the first.
 */
function headerCheckbox(container: HTMLElement) {
  const checkbox = container.querySelector('[role="checkbox"]');
  if (!checkbox) throw new Error("no checkbox rendered");
  return checkbox;
}

beforeEach(() => {
  setPathname("/users");
  setSearchParams("");
});

describe("<DataTable>", () => {
  it("shows the header checkbox in three distinct states", () => {
    // "some" must not look like "all": the operator's only check before a bulk
    // delete is what the header box says.
    expect(headerCheckbox(renderTable([]).container).getAttribute("aria-checked")).toBe("false");
    expect(headerCheckbox(renderTable(["a"]).container).getAttribute("aria-checked")).toBe("mixed");
    expect(
      headerCheckbox(renderTable(["a", "b", "c"]).container).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("carries the attribute and the group class the dash is drawn from", () => {
    // `aria-checked="mixed"` above is what a screen reader hears; this is what
    // an *eye* depends on. `src/components/ui/checkbox.tsx` swaps the tick for a
    // dash with `group-data-indeterminate/checkbox:block`, which needs both
    // halves of the selector on the root -- and neither is visible in jsdom's
    // rendering, so a rename of Base UI's attribute would otherwise only show
    // up as a half-selected box wearing a full one's tick. (The compiled
    // stylesheet really does emit
    // `.group-data-indeterminate\/checkbox\:block:is(:where(.group\/checkbox)[data-indeterminate] *)`;
    // that half is a build artefact and cannot be asserted here.)
    const checkbox = headerCheckbox(renderTable(["a"]).container);

    expect(checkbox.hasAttribute("data-indeterminate")).toBe(true);
    expect(checkbox.classList.contains("group/checkbox")).toBe(true);
    // And not on a fully selected one, or the dash would replace every tick.
    expect(
      headerCheckbox(renderTable(["a", "b", "c"]).container).hasAttribute("data-indeterminate"),
    ).toBe(false);
  });

  it("adds only this page's rows when the header is ticked", () => {
    // "z" is a row from another page. The bulk delete that follows must not
    // reach rows the operator never saw -- the rule toggleAll() encodes, here
    // proved to be wired to the *page's* ids rather than to everything.
    const { container, onSelectedChange } = renderTable(["z"]);

    fireEvent.click(headerCheckbox(container));

    expect(onSelectedChange).toHaveBeenCalledWith(["z", "a", "b", "c"]);
  });

  it("clears only this page's rows when the header is unticked", () => {
    const { container, onSelectedChange } = renderTable(["z", "a", "b", "c"]);

    fireEvent.click(headerCheckbox(container));

    expect(onSelectedChange).toHaveBeenCalledWith(["z"]);
  });

  it("sorts by navigation, carrying the current search along", () => {
    // Sorting is a link, not state: it has to survive a reload and reach the
    // server, and it must not throw away the query that produced the list.
    setSearchParams("q=ada");
    renderTable([]);

    // No `dir=asc` in the href: buildListHref omits the defaults, so ascending
    // is the absence of the parameter.
    expect(screen.getByRole("link", { name: /Name/ }).getAttribute("href")).toBe(
      "/users?q=ada&sort=name",
    );
  });

  it("flips the direction on the column already sorted", () => {
    setSearchParams("sort=name&dir=asc");
    renderTable([]);

    expect(screen.getByRole("link", { name: /Name/ }).getAttribute("href")).toBe(
      "/users?sort=name&dir=desc",
    );
  });

  it("leaves a column that is not sortable as plain text", () => {
    renderTable([]);

    expect(screen.queryByRole("link", { name: /Slug/ })).toBe(null);
  });

  it("says so when there is nothing to show", () => {
    // Asserted against de.json: an empty <tbody> reads as a broken page, and
    // English here would not prove the message comes from a catalog.
    renderWithProviders(
      <DataTable
        rows={[]}
        columns={columns}
        rowId={(row) => row.slug}
        selected={[]}
        onSelectedChange={vi.fn()}
      />,
      { locale: "de" },
    );

    expect(screen.getByText("Nichts vorhanden.")).toBeTruthy();
  });
});
