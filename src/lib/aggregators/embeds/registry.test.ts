import { describe, it, expect, beforeEach } from "vitest";
import type { CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { EmbedBlock } from "../blocks/types";
import {
  EMBED_PROVIDERS_REGISTRY,
  clearEmbedProviders,
  convertEmbed,
  registerEmbedProvider,
  type ExtractionContext,
} from "./registry";

describe("embed provider registry", () => {
  beforeEach(() => {
    clearEmbedProviders();
  });

  it("returns null when registry is empty", async () => {
    const result = await convertEmbed({} as Element, {} as CheerioAPI, {});
    expect(result).toBeNull();
  });

  it("returns the first matching provider's result", async () => {
    const block: EmbedBlock = {
      kind: "embed",
      provider: "youtube",
      externalUrl: "https://www.youtube.com/watch?v=abc123",
      thumbnailRef: "",
      title: "Test",
    };
    registerEmbedProvider({
      key: "youtube",
      detect: () => true,
      convert: async () => block,
    });
    registerEmbedProvider({
      key: "dailymotion",
      detect: () => true,
      convert: async () => ({
        kind: "embed",
        provider: "dailymotion",
        externalUrl: "https://dailymotion.com/video/x123",
        thumbnailRef: "",
        title: "Wrong",
      }),
    });
    const result = await convertEmbed({} as Element, {} as CheerioAPI, {});
    expect(result).toEqual(block);
  });

  it("skips a provider that detects but returns null", async () => {
    const block: EmbedBlock = {
      kind: "embed",
      provider: "dailymotion",
      externalUrl: "https://dailymotion.com/video/x123",
      thumbnailRef: "",
      title: "Fallback",
    };
    registerEmbedProvider({
      key: "youtube",
      detect: () => true,
      convert: async () => null, // detected but can't convert
    });
    registerEmbedProvider({
      key: "dailymotion",
      detect: () => true,
      convert: async () => block,
    });
    const result = await convertEmbed({} as Element, {} as CheerioAPI, {});
    expect(result).toEqual(block);
  });

  it("returns null when no provider detects the element", async () => {
    registerEmbedProvider({
      key: "youtube",
      detect: () => false,
      convert: async () => ({
        kind: "embed",
        provider: "youtube",
        externalUrl: "https://youtube.com",
        thumbnailRef: "",
        title: "",
      }),
    });
    const result = await convertEmbed({} as Element, {} as CheerioAPI, {});
    expect(result).toBeNull();
  });

  it("clearEmbedProviders empties the registry", () => {
    registerEmbedProvider({
      key: "youtube",
      detect: () => true,
      convert: async () => null,
    });
    expect(EMBED_PROVIDERS_REGISTRY.length).toBe(1);
    clearEmbedProviders();
    expect(EMBED_PROVIDERS_REGISTRY.length).toBe(0);
  });
});
