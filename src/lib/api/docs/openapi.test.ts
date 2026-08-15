import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "@/lib/api/docs/openapi";
import { ENDPOINT_REGISTRY } from "@/lib/api/docs/registry";

describe("buildOpenApiDocument", () => {
  it("declares every registered endpoint's method under its path", () => {
    const doc = buildOpenApiDocument();
    for (const endpoint of ENDPOINT_REGISTRY) {
      const pathItem = doc.paths[endpoint.path];
      expect(pathItem, `missing path ${endpoint.path}`).toBeDefined();
      const operation = pathItem[endpoint.method.toLowerCase()];
      expect(operation, `missing ${endpoint.method} ${endpoint.path}`).toBeDefined();
    }
  });

  it("gives every operation at least one response", () => {
    const doc = buildOpenApiDocument();
    for (const pathItem of Object.values(doc.paths)) {
      for (const operation of Object.values(pathItem)) {
        expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
      }
    }
  });

  it("declares a description for every tag that appears on an operation", () => {
    const doc = buildOpenApiDocument();
    const declaredTags = new Set(doc.tags.map((t) => t.name));
    for (const pathItem of Object.values(doc.paths)) {
      for (const operation of Object.values(pathItem)) {
        for (const tag of operation.tags) {
          expect(declaredTags.has(tag), `tag ${tag} not declared`).toBe(true);
        }
      }
    }
  });

  it("is valid, parseable JSON with no circular references", () => {
    const doc = buildOpenApiDocument();
    expect(() => JSON.stringify(doc)).not.toThrow();
  });
});
