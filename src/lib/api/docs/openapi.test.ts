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

  it("includes every registered error code in the generated errors table", () => {
    const doc = buildOpenApiDocument();
    const allCodes = new Set(ENDPOINT_REGISTRY.flatMap((e) => e.errors.map((err) => err.code)));
    for (const code of allCodes) {
      expect(doc.info.description).toContain(code);
    }
  });

  it("declares bearerAuth and cookieAuth security schemes", () => {
    const doc = buildOpenApiDocument();
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: "http", scheme: "bearer" });
    expect(doc.components.securitySchemes.cookieAuth).toEqual({
      type: "apiKey",
      in: "cookie",
      name: "better-auth.session_token",
    });
  });

  it("gives every operation a security field consistent with its registry auth value, or a one-time-token note", () => {
    const doc = buildOpenApiDocument();
    for (const endpoint of ENDPOINT_REGISTRY) {
      const operation = doc.paths[endpoint.path][endpoint.method.toLowerCase()];
      switch (endpoint.auth) {
        case "bearer-or-cookie":
        case "bearer-only":
          expect(operation.security).toEqual([{ bearerAuth: [] }]);
          break;
        case "session-cookie":
          expect(operation.security).toEqual([{ cookieAuth: [] }]);
          break;
        case "none":
          expect(operation.security).toEqual([]);
          break;
        case "one-time-token":
          expect(operation.security).toBeUndefined();
          expect(operation.description).toMatch(/query parameter/);
          break;
      }
    }
  });

  it("carries the two registered examples through into the document", () => {
    const doc = buildOpenApiDocument();

    const syncOp = doc.paths["/api/v1/articles/sync"].get;
    const syncExamples = syncOp.responses["200"].content?.["application/json"].examples;
    expect(syncExamples?.default.value).toEqual({
      new: [],
      updated: [],
      removed: [],
      nextCursor: "eyJuZXdQb3MiOlswLDBdfQ",
    });

    const patchOp = doc.paths["/api/v1/articles/{id}"].patch;
    const patchRequestExamples = patchOp.requestBody?.content["application/json"].examples;
    expect(patchRequestExamples?.default.value).toEqual({ starred: true });
    const patchResponseExamples = patchOp.responses["200"].content?.["application/json"].examples;
    expect(patchResponseExamples?.default.value).toMatchObject({ id: 1, starred: true });
  });
});
