import { describe, expect, it, vi } from "vitest";

// The real stub module -- see src/test/next-server.ts. `connection()` throws
// "used outside a request scope" when called from a bare test invocation.
vi.mock("next/server", () => import("@/test/next-server"));

const requireUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireUser }));

const fakeDocument = { openapi: "3.1.0", info: { title: "fake" } };
const buildOpenApiDocument = vi.fn(() => fakeDocument);
vi.mock("@/lib/api/docs/openapi", () => ({ buildOpenApiDocument }));

describe("GET /api/v1/openapi.json", () => {
  it("requires a signed-in caller before building the document", async () => {
    requireUser.mockRejectedValueOnce(new Error("not signed in"));
    const { GET } = await import("./route");

    await expect(GET()).rejects.toThrow("not signed in");
    expect(buildOpenApiDocument).not.toHaveBeenCalled();
  });

  it("returns the generated OpenAPI document as JSON once signed in", async () => {
    requireUser.mockResolvedValueOnce({ id: "user-1" });
    const { GET } = await import("./route");

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(fakeDocument);
  });
});
