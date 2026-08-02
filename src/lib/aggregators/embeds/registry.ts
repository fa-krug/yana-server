/**
 * Embed provider registry — first-match-wins dispatch table.
 *
 * Each provider registers a `detect` function and a `convert` function.
 * The parser calls `convertEmbed` which iterates the registry in order.
 * Order matters: a generic detector placed before a specific one silently
 * swallows every specific case.
 */

import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { EmbedBlock, EmbedProvider } from "../blocks/types";

/** Context passed through the embed conversion pipeline. */
export interface ExtractionContext {
  baseUrl?: string;
}

/** Spec for a single embed provider in the registry. */
export interface EmbedProviderSpec {
  key: EmbedProvider;
  detect: (element: Element, $: CheerioAPI) => boolean;
  convert: (
    element: Element,
    $: CheerioAPI,
    context: ExtractionContext,
  ) => Promise<EmbedBlock | null>;
}

/**
 * Ordered registry of embed providers. First match wins.
 *
 * Providers are registered here in their import modules via
 * `registerEmbedProvider`.  The order of registration determines
 * detection priority.
 *
 * Initial order (populated by provider modules):
 *   1. YouTube — most common embed, has class markers
 *   2. Dailymotion — class markers, must be before generic
 *   3. Bluesky — link-based detection (bsky.app)
 *   4. Twitter/X — link-based detection, broader match
 *   5. (generic falls through to null — no catch-all provider)
 */
export const EMBED_PROVIDERS_REGISTRY: EmbedProviderSpec[] = [];

/**
 * Register an embed provider.  Appends to the end of the registry.
 * For explicit ordering control, providers should be imported in the
 * correct order (see `initEmbedProviders`).
 */
export function registerEmbedProvider(spec: EmbedProviderSpec): void {
  EMBED_PROVIDERS_REGISTRY.push(spec);
}

/**
 * Clear all providers (for testing).
 */
export function clearEmbedProviders(): void {
  EMBED_PROVIDERS_REGISTRY.length = 0;
}

/**
 * Iterate the registry in order.  Returns the first provider's conversion
 * result, or `null` when nothing matches.
 *
 * An unrecognized embed returns `null` (no block), NOT a `generic` block
 * with an empty URL — an empty embed renders as a dead tap target on the
 * client.
 */
export async function convertEmbed(
  element: Element,
  $: CheerioAPI,
  context: ExtractionContext,
): Promise<EmbedBlock | null> {
  for (const spec of EMBED_PROVIDERS_REGISTRY) {
    if (spec.detect(element, $)) {
      const result = await spec.convert(element, $, context);
      if (result !== null) {
        return result;
      }
      // Provider detected but convert returned null → try next
    }
  }
  return null;
}
