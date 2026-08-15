import { describe, expect, it, vi } from "vitest";

// The real stub module -- see src/test/next-server.ts. `connection()` throws
// "used outside a request scope" when called from a bare test invocation.
vi.mock("next/server", () => import("@/test/next-server"));

const requireUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({ requireUser }));

const referenceResponse = new Response("<html>scalar reference</html>");
const renderReference = vi.fn(async () => referenceResponse);
const ApiReference = vi.fn(() => renderReference);
vi.mock("@scalar/nextjs-api-reference", () => ({ ApiReference }));

describe("GET /api-docs", () => {
  it("configures Scalar with the generated OpenAPI document's URL", async () => {
    await import("./route");
    expect(ApiReference).toHaveBeenCalledWith({ url: "/api/v1/openapi.json" });
  });

  it("requires a signed-in caller before rendering the reference", async () => {
    requireUser.mockRejectedValueOnce(new Error("not signed in"));
    const { GET } = await import("./route");

    await expect(GET()).rejects.toThrow("not signed in");
    expect(renderReference).not.toHaveBeenCalled();
  });

  it("hands back Scalar's own response once signed in", async () => {
    requireUser.mockResolvedValueOnce({ id: "user-1" });
    const { GET } = await import("./route");

    expect(await GET()).toBe(referenceResponse);
  });
});
