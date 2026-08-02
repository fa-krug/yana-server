/**
 * Barrel export for the embed provider system.
 */
export {
  convertEmbed,
  registerEmbedProvider,
  clearEmbedProviders,
  EMBED_PROVIDERS_REGISTRY,
  type ExtractionContext,
  type EmbedProviderSpec,
} from "./registry";
