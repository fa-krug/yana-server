"use client";

import * as React from "react";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";

import { cn } from "@/lib/utils";

/**
 * The app's `<Autocomplete>` -- composed the same way as `./select.tsx`:
 * `render`-prop composition on top of Base UI, no `asChild`. Unlike
 * `<Select>`, this one is a free-text input with clickable suggestions, not a
 * fixed set of options with one selected value -- see the identifier-search
 * usage in `src/components/feeds/identifier-autocomplete.tsx`, which tracks
 * the actually-selected item's `value` itself rather than trusting this
 * component's own `value` (which is only ever the visible input text).
 */

/**
 * `items` narrowed to the flat-array shape only: Base UI's own `Root.Props<ItemValue>`
 * types it as the broader grouped-or-flat union, which resolves against neither of
 * `AutocompleteRoot`'s two real overloads when spread; this component only ever
 * renders flat search results, never grouped ones.
 */
type AutocompleteProps<ItemValue> = Omit<
  AutocompletePrimitive.Root.Props<ItemValue>,
  "items"
> & {
  items?: readonly ItemValue[];
};

function Autocomplete<ItemValue>(props: AutocompleteProps<ItemValue>) {
  return <AutocompletePrimitive.Root {...props} />;
}

function AutocompleteInput({ className, ...props }: AutocompletePrimitive.Input.Props) {
  return (
    <AutocompletePrimitive.Input
      data-slot="autocomplete-input"
      className={cn(
        "flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
        className,
      )}
      {...props}
    />
  );
}

function AutocompletePopup({ className, children, ...props }: AutocompletePrimitive.Popup.Props) {
  return (
    <AutocompletePrimitive.Portal>
      <AutocompletePrimitive.Positioner side="bottom" sideOffset={4} className="isolate z-50">
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-popup"
          className={cn(
            "relative isolate z-50 max-h-(--available-height) w-(--anchor-width) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            className,
          )}
          {...props}
        >
          <AutocompletePrimitive.List>{children}</AutocompletePrimitive.List>
        </AutocompletePrimitive.Popup>
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  );
}

function AutocompleteItem({ className, children, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "relative flex w-full cursor-default items-center rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </AutocompletePrimitive.Item>
  );
}

function AutocompleteEmpty({ className, ...props }: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="autocomplete-empty"
      className={cn("px-2.5 py-2 text-sm text-muted-foreground empty:m-0 empty:p-0", className)}
      {...props}
    />
  );
}

function AutocompleteStatus({ className, ...props }: AutocompletePrimitive.Status.Props) {
  return (
    <AutocompletePrimitive.Status
      data-slot="autocomplete-status"
      className={cn("px-2.5 py-2 text-sm text-muted-foreground empty:m-0 empty:p-0", className)}
      {...props}
    />
  );
}

export {
  Autocomplete,
  AutocompleteInput,
  AutocompletePopup,
  AutocompleteItem,
  AutocompleteEmpty,
  AutocompleteStatus,
};
