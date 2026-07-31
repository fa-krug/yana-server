import type { MessageKeys, Messages, NestedKeyOf } from "next-intl";

import type enMessages from "../../messages/en.json";

/**
 * Makes catalog keys a compiler-checked type instead of plain `string`.
 *
 * Without this, `t("settngs.title")` is a perfectly valid call that renders the
 * raw key path to the user, and nothing catches it: src/i18n/messages.test.ts
 * only compares the two catalogs to each other, and settings.test.ts's
 * key-resolves check only covers the keys the actions emit. Both of those are
 * hand-built substitutes for this type. Doing it now, before phases 5-13 add
 * hundreds of keys, is the cheap moment.
 *
 * next-intl 4 reads the shape from `AppConfig`, not from a global
 * `IntlMessages` interface -- that was the v3 form and augmenting it here does
 * nothing at all (see `export type Messages = AppConfig extends { Messages:
 * infer AppMessages } ? ... : Record<string, any>` in
 * node_modules/use-intl/dist/types/core/AppConfig.d.ts, which is what
 * useTranslations() and getTranslations() are both parameterized on).
 *
 * Two details this depends on and that will break it silently if changed:
 *
 * 1. This file must stay a *module* -- the imports above are what make it one.
 *    A `.d.ts` with no top-level import/export is a global script, and
 *    `declare module "next-intl"` inside one *replaces* next-intl's types
 *    wholesale instead of augmenting them ("Module 'next-intl' has no exported
 *    member 'useTranslations'" on every call site).
 * 2. en.json is the reference catalog; de.json is held to it by
 *    src/i18n/messages.test.ts, which asserts the two define identical keys.
 */
declare module "next-intl" {
  interface AppConfig {
    Messages: typeof enMessages;
    Locale: "en" | "de";
  }
}

/**
 * Every dotted path in the catalogs whose value is a message (not a nested
 * group) -- e.g. "nav.feeds", "settings.library.retentionRange".
 *
 * Exported so a value that is *later* passed to `t()` can be typed at its
 * source. A dynamic `t(someString)` cannot typecheck against a literal union,
 * and casting at the call site would defeat the whole point of the
 * augmentation, so the fix is always to narrow the producer: see
 * `NavItem["labelKey"]` in src/lib/nav.ts and `errorKey` in
 * src/lib/settings/actions.ts.
 */
export type CatalogKey = MessageKeys<Messages, NestedKeyOf<Messages>>;

/** The same, relative to one top-level namespace: NamespaceKey<"settings">. */
export type NamespaceKey<Namespace extends keyof Messages> = MessageKeys<
  Messages[Namespace],
  NestedKeyOf<Messages[Namespace]>
>;
