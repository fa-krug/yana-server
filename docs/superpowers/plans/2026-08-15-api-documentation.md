# API Documentation Implementation Plan

**Amended after implementation.** Task 8 as written below specifies a `page.tsx`, `page.test.tsx`, a `UNLISTED_ROUTES` entry, and a `nav.apiDocs` catalog key. All four were superseded during execution: the pinned `@scalar/nextjs-api-reference@0.11.14` package exports a Route Handler factory, not a React component, so Task 8 shipped as `src/app/(app)/api-docs/route.ts` + `route.test.ts` instead, and the nav/catalog additions -- having no remaining reader once the page approach was dropped -- were added then removed in two follow-up fix rounds. See the design spec's own amendment note for the same story.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate an OpenAPI 3.1 document from a zod-schema registry describing every `/api/v1/**` route (plus the three flows a native client needs to reach it), commit it with a CI drift check, and render it as a browsable, signed-in-only in-app reference.

**Architecture:** A `src/lib/api/docs/` module tree: zod schemas are the single source of truth for both request validation and response shape (`serializers.ts` inverts to `z.infer` its wire types from them); a `defineEndpoint()` registry (mirroring `defineIntegration()`'s shape) declares one entry per route; `buildOpenApiDocument()` converts the registry to OpenAPI 3.1 via zod 4's native `z.toJSONSchema()`; a completeness test walks the route tree and fails if any route lacks a registry entry. The document is committed, CI-checked for drift, served at `GET /api/v1/openapi.json`, and rendered at `/api-docs` via `@scalar/nextjs-api-reference`.

**Tech Stack:** Next.js 16 / React 19 / TypeScript, zod 4.4.3 (already pinned — `z.toJSONSchema()` needs no new dependency), `@scalar/nextjs-api-reference` (new, pinned exact), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-api-documentation-design.md`

## Global Constraints

- No `^`/`~` on any new dependency in `package.json`; run `npm install` after adding one so `package-lock.json` regenerates, and grep both files for `^`/`~` before committing (root `CLAUDE.md`, "Conventions").
- Line length 100, double quotes, semicolons, trailing commas — Prettier owns this; run `npm run format` before each commit if unsure.
- `@/*` path alias — new files under `src/lib/api/docs/` import via `@/lib/api/docs/...`, never relative paths crossing into `src/lib/db` etc. from outside `src/lib`.
- Every new `.ts` file under `src/lib/**` needing a real-database test uses the `node` vitest project (`.test.ts`, real SQLite via `src/lib/db/test-support.ts`) — no driver mocks. A new React component test (`.test.tsx`) uses the `dom` project and `src/test/render.tsx`'s `renderWithProviders()`.
- `CHECK`/schema changes are not part of this plan — no migration is added; only application-layer files change.
- Documentation content (Section 4 of the spec, "narrative.ts") is **English only**, a deliberate, explicit exception to the `messages/en.json`/`de.json` parity rule — do not add these strings to either catalog.
- The `/api-docs` **nav label** (not its content) is ordinary UI chrome and **does** need a catalog key in both `en.json` and `de.json`, enforced by `src/i18n/messages.test.ts` — this is the one place this plan touches the catalogs.
- Before pushing: `npm run lint && npm run format:check && npm run typecheck && npm test` must all pass (CI runs these; `docs:api:check` is added to this list in Task 8).

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/api/docs/schemas.ts` | create | zod schema per wire shape (requests + responses) |
| `src/lib/api/serializers.ts` | modify | `*Wire` types become `z.infer<typeof ...Schema>` |
| `src/app/api/v1/reading-position/route.ts` | modify | import `ReadingPositionPatchBodySchema` instead of a local `patchBody` |
| `src/app/api/v1/articles/[id]/route.ts` | modify | import `ArticlePatchBodySchema` instead of a local `patchBody` |
| `src/lib/api/docs/define.ts` | create | `EndpointDoc` type + `defineEndpoint()` |
| `src/lib/api/docs/registry.ts` | create | one `defineEndpoint()` call per documented route |
| `src/lib/api/docs/registry.test.ts` | create | completeness check against the real route tree |
| `src/lib/api/docs/narrative.ts` | create | markdown prose for `info.description` + per-tag descriptions |
| `src/lib/api/docs/openapi.ts` | create | `buildOpenApiDocument()` |
| `src/lib/api/docs/openapi.test.ts` | create | structural validity of the generated document |
| `scripts/docs-api.ts` | create | writes/checks `docs/api/openapi.json` |
| `scripts/docs-api.test.ts` | create | proves `--check` exits non-zero on drift |
| `docs/api/openapi.json` | create (generated) | committed spec artifact |
| `package.json` | modify | `docs:api`, `docs:api:check` scripts + `@scalar/nextjs-api-reference` dependency |
| `src/app/api/v1/openapi.json/route.ts` | create | serves the generated document, signed-in only |
| `src/app/(app)/api-docs/page.tsx` | create | renders the spec via Scalar |
| `src/app/(app)/api-docs/page.test.tsx` | create | jsdom render / auth-gate test |
| `src/lib/nav.ts` | modify | add `/api-docs` to `UNLISTED_ROUTES` |
| `messages/en.json`, `messages/de.json` | modify | `nav.apiDocs` key |
| `src/components/settings/about-section.tsx` | modify | link to `/api-docs` |
| `src/components/settings/about-section.test.tsx` | modify | assert the new link renders |
| `.github` CI config or equivalent | modify | add `docs:api:check` to the CI command line |

---

## Task 1: Schema layer — `schemas.ts` and the `serializers.ts` inversion

**Files:**
- Create: `src/lib/api/docs/schemas.ts`
- Modify: `src/lib/api/serializers.ts`
- Test: `src/lib/api/serializers.test.ts` (existing file — extend, don't replace)

**Interfaces:**
- Produces: `ArticleSummarySchema`, `FeedSchema`, `TagSchema`, `ReadingPositionSchema`, `SyncPageSchema`, `RunSchema`, `ApiErrorSchema`, `ArticleContentSchema` (the `WireDocument` shape), `AiPromptResponseSchema`, `ApiEventSchema` (the SSE payload union), plus request schemas `ReadingPositionPatchBodySchema`, `ArticlePatchBodySchema` — all exported from `src/lib/api/docs/schemas.ts`.
- Consumes: `src/lib/db/schema` column types (read-only, for reference while writing schemas — no import of Drizzle table objects into `schemas.ts` itself).

- [ ] **Step 1: Write `schemas.ts` with every response and request schema**

```ts
// src/lib/api/docs/schemas.ts
import { z } from "zod";

export const ArticleSummarySchema = z.object({
  id: z.number().int(),
  feedId: z.number().int(),
  name: z.string(),
  identifier: z.string(),
  date: z.iso.datetime(),
  author: z.string(),
  icon: z.string().nullable(),
  read: z.boolean(),
  starred: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const FeedSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  aggregator: z.string(),
  identifier: z.string(),
  enabled: z.boolean(),
  dailyLimit: z.number().int(),
  updateIntervalMinutes: z.number().int(),
  concurrency: z.number().int(),
  tagIds: z.array(z.number().int()),
  logoImageHash: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export const TagSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  color: z.string(),
});

export const ReadingPositionSchema = z.object({
  articleId: z.number().int().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});

export const SyncPageSchema = z.object({
  new: z.array(ArticleSummarySchema),
  updated: z.array(ArticleSummarySchema),
  removed: z.array(z.number().int()),
  nextCursor: z.string(),
});

export const SyncResyncRequiredSchema = z.object({
  resyncRequired: z.literal(true),
});

export const RunSchema = z.object({
  runId: z.number().int(),
  status: z.enum(["running", "completed"]),
  totalJobs: z.number().int(),
  completedJobs: z.number().int(),
  failedJobs: z.number().int(),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// The article-content wire format (`WireDocument` in
// src/lib/aggregators/blocks/schema.ts) -- a recursive block tree, so the
// runs/blocks fields are declared via z.lazy().
const WireInlineRunSchema = z.object({
  text: z.string(),
  styles: z.array(z.string()),
  link: z.string().nullable(),
});

const WireBlockSchema: z.ZodType = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("paragraph"), runs: z.array(WireInlineRunSchema) }),
    z.object({
      type: z.literal("heading"),
      level: z.number().int(),
      runs: z.array(WireInlineRunSchema),
    }),
    z.object({
      type: z.literal("list"),
      ordered: z.boolean(),
      items: z.array(z.array(WireBlockSchema)),
    }),
    z.object({ type: z.literal("blockquote"), blocks: z.array(WireBlockSchema) }),
    z.object({ type: z.literal("image"), ref: z.string(), caption: z.array(WireInlineRunSchema) }),
    z.object({
      type: z.literal("embed"),
      provider: z.string(),
      thumbnailRef: z.string().nullable(),
      externalURL: z.string(),
      title: z.string().nullable(),
    }),
    z.object({
      type: z.literal("codeBlock"),
      text: z.string(),
      language: z.string().nullable(),
    }),
    z.object({ type: z.literal("divider") }),
  ]),
);

export const ArticleContentSchema = z.object({
  version: z.number().int(),
  blocks: z.array(WireBlockSchema),
});

export const AiPromptResponseSchema = z.object({
  response: z.string(),
  provider: z.string(),
  model: z.string(),
});

export const ApiEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("job"),
    payload: z.object({
      jobId: z.number().int(),
      runId: z.number().int().nullable(),
      kind: z.string(),
      status: z.string(),
      progress: z.number(),
    }),
  }),
  z.object({
    type: z.literal("run"),
    payload: z.object({
      runId: z.number().int(),
      status: z.string(),
      totalJobs: z.number().int(),
      completedJobs: z.number().int(),
      failedJobs: z.number().int(),
    }),
  }),
  z.object({
    type: z.literal("readingPosition"),
    payload: z.object({
      articleId: z.number().int(),
      updatedAt: z.iso.datetime(),
    }),
  }),
]);

// Request bodies -- imported by the routes themselves (Step 5 below), not
// duplicated there, so the schema the docs describe and the schema a route
// validates against are the same object.
export const ReadingPositionPatchBodySchema = z.object({ articleId: z.number().int() });

export const ArticlePatchBodySchema = z
  .object({ starred: z.boolean().optional(), read: z.boolean().optional() })
  .refine((body) => body.starred !== undefined || body.read !== undefined, {
    message: "Provide starred and/or read.",
  });
```

- [ ] **Step 2: Run typecheck to confirm the new file compiles standalone**

Run: `npx tsc --noEmit`
Expected: PASS (no consumers yet, so this only proves `schemas.ts` itself is well-typed)

- [ ] **Step 3: Invert `serializers.ts` to derive its `*Wire` types from the new schemas**

Edit `src/lib/api/serializers.ts`:

```ts
import type { Article, Feed, Tag, UserSettings } from "@/lib/db/schema";
import type { z } from "zod";

import type {
  ArticleSummarySchema,
  FeedSchema,
  ReadingPositionSchema,
  TagSchema,
} from "@/lib/api/docs/schemas";

export type ArticleSummaryWire = z.infer<typeof ArticleSummarySchema>;

export function serializeArticleSummary(article: Article): ArticleSummaryWire {
  return {
    id: article.id,
    feedId: article.feedId,
    name: article.name,
    identifier: article.identifier,
    date: article.date.toISOString(),
    author: article.author,
    icon: article.icon,
    read: article.read,
    starred: article.starred,
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString(),
  };
}

export type FeedWire = z.infer<typeof FeedSchema>;

export function serializeFeed(feed: Feed, tagIds: number[]): FeedWire {
  return {
    id: feed.id,
    name: feed.name,
    aggregator: feed.aggregator,
    identifier: feed.identifier,
    enabled: feed.enabled,
    dailyLimit: feed.dailyLimit,
    updateIntervalMinutes: feed.updateIntervalMinutes,
    concurrency: feed.concurrency,
    tagIds,
    logoImageHash: feed.logoImageHash,
    updatedAt: feed.updatedAt.toISOString(),
  };
}

export type TagWire = z.infer<typeof TagSchema>;

export function serializeTag(tag: Tag): TagWire {
  return { id: tag.id, name: tag.name, color: tag.color };
}

export type ReadingPositionWire = z.infer<typeof ReadingPositionSchema>;

/**
 * `settings` is typed to the two columns this needs rather than the whole
 * `UserSettings` row, so a caller can pass either a full row (`GET`) or the
 * narrower `.select({...})` projection `PATCH` re-reads after its `UPDATE`
 * (`src/app/api/v1/reading-position/route.ts`) without a cast.
 */
export function serializeReadingPosition(
  settings: Pick<UserSettings, "readingPositionArticleId" | "readingPositionUpdatedAt">,
): ReadingPositionWire {
  return {
    articleId: settings.readingPositionArticleId,
    updatedAt: settings.readingPositionUpdatedAt?.toISOString() ?? null,
  };
}
```

Keep every existing export name (`ArticleSummaryWire`, `serializeArticleSummary`, `FeedWire`, `serializeFeed`, `TagWire`, `serializeTag`, `ReadingPositionWire`, `serializeReadingPosition`) unchanged so no consumer needs an edit.

- [ ] **Step 4: Run the existing serializer test suite**

Run: `npx vitest run src/lib/api/serializers.test.ts`
Expected: PASS unchanged — this step only proves the inversion didn't change any serializer's output shape.

- [ ] **Step 5: Point the two routes with local request schemas at the shared ones**

Edit `src/app/api/v1/reading-position/route.ts` — replace:
```ts
const patchBody = z.object({ articleId: z.number().int() });
```
with:
```ts
import { ReadingPositionPatchBodySchema } from "@/lib/api/docs/schemas";
```
and every reference to `patchBody` in that file becomes `ReadingPositionPatchBodySchema` (the `z` import in that file is then unused — remove it if nothing else in the file needs it).

Edit `src/app/api/v1/articles/[id]/route.ts` similarly — replace the local `patchBody` declaration with an import of `ArticlePatchBodySchema` from `@/lib/api/docs/schemas`, and replace every `patchBody` reference.

- [ ] **Step 6: Run the full route test suites and typecheck**

Run: `npx vitest run src/app/api/v1/reading-position src/app/api/v1/articles && npx tsc --noEmit`
Expected: PASS — request validation behavior is identical, only the schema's declaration site moved.

- [ ] **Step 7: Add a round-trip test proving each response schema accepts real serializer output**

Create `src/lib/api/docs/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ArticleSummarySchema,
  FeedSchema,
  ReadingPositionSchema,
  TagSchema,
} from "@/lib/api/docs/schemas";
import {
  serializeArticleSummary,
  serializeFeed,
  serializeReadingPosition,
  serializeTag,
} from "@/lib/api/serializers";

describe("response schemas accept real serializer output", () => {
  it("ArticleSummarySchema", () => {
    const wire = serializeArticleSummary({
      id: 1,
      feedId: 2,
      name: "Title",
      identifier: "guid",
      date: new Date(),
      author: "Ada",
      icon: null,
      read: false,
      starred: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      // Remaining Article columns not read by serializeArticleSummary:
      rawContent: "",
      plainText: "",
    } as never);
    expect(() => ArticleSummarySchema.parse(wire)).not.toThrow();
  });

  it("FeedSchema", () => {
    const wire = serializeFeed(
      {
        id: 1,
        name: "Feed",
        aggregator: "full_website",
        identifier: "",
        enabled: true,
        dailyLimit: 20,
        updateIntervalMinutes: 30,
        concurrency: 4,
        logoImageHash: null,
        updatedAt: new Date(),
      } as never,
      [1, 2],
    );
    expect(() => FeedSchema.parse(wire)).not.toThrow();
  });

  it("TagSchema", () => {
    const wire = serializeTag({ id: 1, name: "News", color: "red" } as never);
    expect(() => TagSchema.parse(wire)).not.toThrow();
  });

  it("ReadingPositionSchema, both populated and empty", () => {
    expect(() =>
      ReadingPositionSchema.parse(
        serializeReadingPosition({
          readingPositionArticleId: 5,
          readingPositionUpdatedAt: new Date(),
        }),
      ),
    ).not.toThrow();
    expect(() =>
      ReadingPositionSchema.parse(
        serializeReadingPosition({
          readingPositionArticleId: null,
          readingPositionUpdatedAt: null,
        }),
      ),
    ).not.toThrow();
  });
});
```

- [ ] **Step 8: Run the new test**

Run: `npx vitest run src/lib/api/docs/schemas.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/lib/api/docs/schemas.ts src/lib/api/docs/schemas.test.ts src/lib/api/serializers.ts \
  src/app/api/v1/reading-position/route.ts src/app/api/v1/articles/[id]/route.ts
git commit -m "feat(api-docs): add zod response/request schemas as the single source of truth"
```

---

## Task 2: Registry scaffold — `define.ts`, empty `registry.ts`, and the completeness test (red)

**Files:**
- Create: `src/lib/api/docs/define.ts`
- Create: `src/lib/api/docs/registry.ts` (starts empty)
- Test: `src/lib/api/docs/registry.test.ts`

**Interfaces:**
- Produces: `EndpointDoc<Req, Res>` type, `defineEndpoint()`, `ENDPOINT_REGISTRY: EndpointDoc<z.ZodType, z.ZodType>[]` (exported from `registry.ts`).
- Consumes: nothing from earlier tasks — `define.ts` imports only `zod`.

- [ ] **Step 1: Write `define.ts`**

```ts
// src/lib/api/docs/define.ts
import type { z } from "zod";

/**
 * One documented `/api/v1/**`-or-flow route. Mirrors the shape
 * `defineIntegration()` (src/lib/integrations/define.ts) established:
 * required fields the compiler enforces, so a new route with no entry -- or
 * an entry missing a field -- fails a build or a test rather than a review.
 */
export interface EndpointDoc<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  tag: string;
  summary: string;
  description: string;
  /**
   * - "bearer-or-cookie": `requireApiUser()` -- Bearer authoritative when
   *   present, cookie fallback otherwise.
   * - "bearer-only": `requireApiBearerSession()` -- Bearer required, no
   *   cookie fallback.
   * - "session-cookie": `requireUser()` -- the ordinary signed-in-user
   *   session, no Bearer path at all (`/device/pair`).
   * - "one-time-token": a single-use token in the query string, verified via
   *   Better Auth's `verifyOneTimeToken` (`/webview-session`).
   * - "none": no authentication (`/health` -- not documented by this
   *   registry today, reserved for completeness).
   */
  auth: "bearer-or-cookie" | "bearer-only" | "session-cookie" | "one-time-token" | "none";
  request?: {
    query?: z.ZodType;
    body?: Req;
  };
  response: {
    status: number;
    schema: Res | null;
    description: string;
    contentType?: string;
  };
  errors: Array<{ status: number; code: string; when: string }>;
  example?: { request?: unknown; response?: unknown };
}

export function defineEndpoint<Req extends z.ZodType, Res extends z.ZodType>(
  doc: EndpointDoc<Req, Res>,
): EndpointDoc<Req, Res> {
  return doc;
}
```

`response.schema: Res | null` covers the two routes with no JSON body at all: `GET /api/v1/images/[hash]` (raw bytes) and the redirect-only `/device/pair` / `/webview-session` (302/307, no body).

- [ ] **Step 2: Create an empty `registry.ts`**

```ts
// src/lib/api/docs/registry.ts
import type { EndpointDoc } from "./define";

export const ENDPOINT_REGISTRY: EndpointDoc[] = [];
```

- [ ] **Step 3: Write the completeness test (must fail red — registry is empty)**

Create `src/lib/api/docs/registry.test.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ENDPOINT_REGISTRY } from "./registry";

/**
 * Every route this plan documents, as (method, path) pairs matching what
 * ENDPOINT_REGISTRY must declare. Hand-listed rather than derived from a glob
 * over HTTP verbs alone, because three of these are flow routes outside
 * /api/v1 (device/pair, webview-session-token, webview-session) -- see the
 * design spec's Goal section for why those three are in scope and nothing
 * else outside /api/v1 is.
 */
const EXPECTED: Array<{ method: string; path: string; file: string }> = [
  { method: "GET", path: "/api/v1/feeds", file: "src/app/api/v1/feeds/route.ts" },
  { method: "GET", path: "/api/v1/tags", file: "src/app/api/v1/tags/route.ts" },
  { method: "GET", path: "/api/v1/articles/sync", file: "src/app/api/v1/articles/sync/route.ts" },
  {
    method: "PATCH",
    path: "/api/v1/articles/{id}",
    file: "src/app/api/v1/articles/[id]/route.ts",
  },
  {
    method: "GET",
    path: "/api/v1/articles/{id}/content",
    file: "src/app/api/v1/articles/[id]/content/route.ts",
  },
  {
    method: "POST",
    path: "/api/v1/articles/{id}/reload",
    file: "src/app/api/v1/articles/[id]/reload/route.ts",
  },
  { method: "POST", path: "/api/v1/aggregate", file: "src/app/api/v1/aggregate/route.ts" },
  { method: "GET", path: "/api/v1/runs/{id}", file: "src/app/api/v1/runs/[id]/route.ts" },
  { method: "GET", path: "/api/v1/jobs/events", file: "src/app/api/v1/jobs/events/route.ts" },
  { method: "GET", path: "/api/v1/images/{hash}", file: "src/app/api/v1/images/[hash]/route.ts" },
  {
    method: "GET",
    path: "/api/v1/reading-position",
    file: "src/app/api/v1/reading-position/route.ts",
  },
  {
    method: "PATCH",
    path: "/api/v1/reading-position",
    file: "src/app/api/v1/reading-position/route.ts",
  },
  { method: "POST", path: "/api/v1/ai/prompt", file: "src/app/api/v1/ai/prompt/route.ts" },
  {
    method: "POST",
    path: "/api/v1/auth/webview-session-token",
    file: "src/app/api/v1/auth/webview-session-token/route.ts",
  },
  { method: "GET", path: "/device/pair", file: "src/app/device/pair/route.ts" },
  { method: "GET", path: "/webview-session", file: "src/app/webview-session/route.ts" },
];

describe("ENDPOINT_REGISTRY completeness", () => {
  it("every route file's exported HTTP methods exist in EXPECTED", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    for (const { method, file } of EXPECTED) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      expect(source, `${file} should export ${method}`).toMatch(
        new RegExp(`export async function ${method}\\(`),
      );
    }
  });

  it("has a defineEndpoint() entry for every expected (method, path) pair", () => {
    const declared = new Set(ENDPOINT_REGISTRY.map((e) => `${e.method} ${e.path}`));
    const missing = EXPECTED.filter((e) => !declared.has(`${e.method} ${e.path}`));
    expect(missing, `missing registry entries: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it("has no registry entry for a route that doesn't exist", () => {
    const expected = new Set(EXPECTED.map((e) => `${e.method} ${e.path}`));
    const extra = ENDPOINT_REGISTRY.filter((e) => !expected.has(`${e.method} ${e.path}`));
    expect(extra, `unexpected registry entries: ${JSON.stringify(extra)}`).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test and confirm it fails red**

Run: `npx vitest run src/lib/api/docs/registry.test.ts`
Expected: FAIL on "has a defineEndpoint() entry for every expected pair" — `ENDPOINT_REGISTRY` is empty. The first test (source contains each method) should already PASS, since every route file already exists.

- [ ] **Step 5: Commit the scaffold and the red test**

```bash
git add src/lib/api/docs/define.ts src/lib/api/docs/registry.ts src/lib/api/docs/registry.test.ts
git commit -m "test(api-docs): add endpoint-registry completeness test (red)"
```

---

## Task 3: Populate the registry — sync, feeds, tags, articles

**Files:**
- Modify: `src/lib/api/docs/registry.ts`

**Interfaces:**
- Consumes: `defineEndpoint()`, `EndpointDoc` (Task 2); `ArticleSummarySchema`, `FeedSchema`, `TagSchema`, `SyncPageSchema`, `SyncResyncRequiredSchema`, `ArticleContentSchema`, `ArticlePatchBodySchema` (Task 1).

- [ ] **Step 1: Add the six sync/feeds/tags/articles entries to `registry.ts`**

```ts
import { z } from "zod";

import {
  ArticleContentSchema,
  ArticlePatchBodySchema,
  ArticleSummarySchema,
  FeedSchema,
  SyncPageSchema,
  SyncResyncRequiredSchema,
  TagSchema,
} from "./schemas";
import { defineEndpoint, type EndpointDoc } from "./define";

export const ENDPOINT_REGISTRY: EndpointDoc[] = [
  defineEndpoint({
    method: "GET",
    path: "/api/v1/feeds",
    tag: "Feeds",
    summary: "List the caller's feeds",
    description:
      "Returns every feed owned by the caller, each carrying its `tagIds` so the " +
      "client can render feed/tag associations without a second round trip per feed.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: z.object({ feeds: z.array(FeedSchema) }),
      description: "The caller's feeds.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/tags",
    tag: "Tags",
    summary: "List the caller's tags",
    description: "Returns every tag owned by the caller.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: z.object({ tags: z.array(TagSchema) }),
      description: "The caller's tags.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/articles/sync",
    tag: "Sync",
    summary: "Delta-sync articles across three independently cursored streams",
    description:
      "Returns `new`, `updated` and `removed` deltas since the given `cursor`, scoped to the " +
      "caller's own feeds. See the Sync protocol overview for the cursor and resync model.",
    auth: "bearer-or-cookie",
    request: {
      query: z.object({
        cursor: z.string().optional().describe("Opaque cursor from a prior response's nextCursor."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max rows per stream per call. Default 200, clamped to [1, 500]."),
      }),
    },
    response: {
      status: 200,
      schema: z.union([SyncPageSchema, SyncResyncRequiredSchema]),
      description:
        "A sync page, or `{ resyncRequired: true }` when the cursor is older than the " +
        "retention job's tombstone-prune horizon and a full resync is required.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
    example: {
      request: { cursor: null, limit: 200 },
      response: { new: [], updated: [], removed: [], nextCursor: "eyJuZXdQb3MiOlswLDBdfQ" },
    },
  }),

  defineEndpoint({
    method: "PATCH",
    path: "/api/v1/articles/{id}",
    tag: "Articles",
    summary: "Set an article's read/starred state",
    description:
      "Updates `read` and/or `starred` on one article owned by the caller. At least one of " +
      "the two fields is required.",
    auth: "bearer-or-cookie",
    request: { body: ArticlePatchBodySchema },
    response: {
      status: 200,
      schema: ArticleSummarySchema,
      description: "The article after the update.",
    },
    errors: [
      { status: 400, code: "invalid_body", when: "neither starred nor read was provided." },
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the article doesn't exist, or its feed isn't owned by the caller.",
      },
    ],
    example: { request: { starred: true }, response: null },
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/articles/{id}/content",
    tag: "Articles",
    summary: "Fetch an article's rendered content blocks",
    description:
      "Returns the article's content as a Yana wire-format document (version + block tree). " +
      "See the Content format overview for the block union.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: ArticleContentSchema,
      description: "The article's content blocks.",
    },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the article doesn't exist, or its feed isn't owned by the caller.",
      },
    ],
  }),

  defineEndpoint({
    method: "POST",
    path: "/api/v1/articles/{id}/reload",
    tag: "Articles",
    summary: "Re-fetch and re-extract one article",
    description:
      "Enqueues an `article.reload` job for one caller-owned article -- the same job the web " +
      "UI's bulk reload action uses, here scoped to a single article via the API.",
    auth: "bearer-or-cookie",
    response: {
      status: 202,
      schema: z.object({ jobId: z.number().int() }),
      description: "The id of the enqueued job.",
    },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the article doesn't exist, or its feed isn't owned by the caller.",
      },
    ],
  }),
];
```

- [ ] **Step 2: Run the completeness test — still red, but with fewer missing entries**

Run: `npx vitest run src/lib/api/docs/registry.test.ts`
Expected: FAIL on the "has a defineEndpoint() entry for every expected pair" test, listing exactly the 10 remaining `(method, path)` pairs not yet added (aggregate, runs/{id}, jobs/events, images/{hash}, reading-position ×2, ai/prompt, auth/webview-session-token, device/pair, webview-session).

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/docs/registry.ts
git commit -m "feat(api-docs): register sync, feeds, tags and article endpoints"
```

---

## Task 4: Populate the registry — runs, jobs/events, images, reading-position

**Files:**
- Modify: `src/lib/api/docs/registry.ts`

**Interfaces:**
- Consumes: `RunSchema`, `ApiEventSchema`, `ReadingPositionSchema`, `ReadingPositionPatchBodySchema` (Task 1).

- [ ] **Step 1: Append these five entries**

```ts
  defineEndpoint({
    method: "POST",
    path: "/api/v1/aggregate",
    tag: "Runs",
    summary: "Trigger aggregation now",
    description:
      "Enqueues one `aggregate` job per caller-owned enabled feed, grouped under a single " +
      "run. A caller with zero enabled feeds still gets a run back, already completed with " +
      "`totalJobs: 0` -- `runId` is always a real, non-null id.",
    auth: "bearer-or-cookie",
    response: {
      status: 202,
      schema: z.object({ runId: z.number().int() }),
      description: "The id of the created run.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/runs/{id}",
    tag: "Runs",
    summary: "Poll a run's progress",
    description:
      "The poll target for a run created by `POST /api/v1/aggregate`. Prefer " +
      "`GET /api/v1/jobs/events` for live progress; this is the always-available fallback.",
    auth: "bearer-or-cookie",
    response: { status: 200, schema: RunSchema, description: "The run's current counters." },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the run doesn't exist, or isn't owned by the caller.",
      },
    ],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/jobs/events",
    tag: "Jobs",
    summary: "Live job/run/reading-position notifications (SSE)",
    description:
      "A long-lived `text/event-stream` connection carrying `job`, `run` and " +
      "`readingPosition` events for the caller, in place of polling " +
      "`GET /api/v1/runs/{id}`. Best-effort: a dropped connection loses only low-latency " +
      "notification, never data -- the `jobs`/`runs` tables and " +
      "`GET /api/v1/reading-position` remain the source of truth to fall back to. See the " +
      "SSE events overview for the payload shapes and reconnection guidance.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: ApiEventSchema,
      description: "One event per SSE `data:` frame (see the SSE events overview).",
      contentType: "text/event-stream",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/images/{hash}",
    tag: "Images",
    summary: "Fetch a feed logo, article image, or embed thumbnail by content hash",
    description:
      "Serves image bytes by their SHA-256 content hash (64 lowercase hex chars). Used by " +
      "both the native client and the web UI's own `<img>` tags. A hash is reachable through " +
      "any of three independent paths -- a caller-owned feed's logo, a caller-owned article's " +
      "body image, or an embed thumbnail -- and a hash owned only by a different user 404s " +
      "exactly as a nonexistent one would.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: null,
      description: "The raw image bytes, with the stored Content-Type.",
      contentType: "image/*",
    },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the hash is malformed, unknown, or not reachable through the caller's own feeds.",
      },
    ],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/reading-position",
    tag: "Reading position",
    summary: "Get the cross-device current-article pointer",
    description:
      "Returns the caller's current reading position, or `{ articleId: null, updatedAt: null " +
      "}` if it was never set.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: ReadingPositionSchema,
      description: "The current pointer.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "PATCH",
    path: "/api/v1/reading-position",
    tag: "Reading position",
    summary: "Set the cross-device current-article pointer",
    description:
      "Sets the pointer to `articleId`, stamping `updatedAt` with the server's clock. " +
      "Last-writer-wins across devices. Publishes a `readingPosition` SSE event to every " +
      "other open `GET /api/v1/jobs/events` connection for the caller.",
    auth: "bearer-or-cookie",
    request: { body: ReadingPositionPatchBodySchema },
    response: {
      status: 200,
      schema: ReadingPositionSchema,
      description: "The pointer after the update.",
    },
    errors: [
      { status: 400, code: "invalid_body", when: "articleId is missing or not an integer." },
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the article doesn't exist, or its feed isn't owned by the caller.",
      },
    ],
  }),
```

- [ ] **Step 2: Run the completeness test**

Run: `npx vitest run src/lib/api/docs/registry.test.ts`
Expected: FAIL, listing only the 4 remaining pairs (ai/prompt, webview-session-token, device/pair, webview-session).

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/docs/registry.ts
git commit -m "feat(api-docs): register runs, jobs/events, images and reading-position endpoints"
```

---

## Task 5: Populate the registry — AI prompt and the three auth/pairing flows (green)

**Files:**
- Modify: `src/lib/api/docs/registry.ts`

**Interfaces:**
- Consumes: `AiPromptResponseSchema` (Task 1).

- [ ] **Step 1: Append the final four entries**

```ts
  defineEndpoint({
    method: "POST",
    path: "/api/v1/ai/prompt",
    tag: "AI",
    summary: "Run a free-form prompt against the caller's configured AI provider",
    description:
      "Runs `prompt` against the caller's active AI provider using their stored credentials " +
      "and global tuning values -- no per-request overrides. Subject to the caller's daily " +
      "and monthly AI request limits.",
    auth: "bearer-or-cookie",
    request: { body: z.object({ prompt: z.string().min(1) }) },
    response: {
      status: 200,
      schema: AiPromptResponseSchema,
      description: "The provider's response.",
    },
    errors: [
      { status: 400, code: "invalid_prompt", when: "prompt is missing or empty." },
      { status: 400, code: "prompt_too_long", when: "prompt exceeds the configured length limit." },
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      { status: 409, code: "no_active_provider", when: "no AI provider is configured." },
      { status: 429, code: "daily_limit_exceeded", when: "the daily AI request limit is reached." },
      {
        status: 429,
        code: "monthly_limit_exceeded",
        when: "the monthly AI request limit is reached.",
      },
      {
        status: 502,
        code: "provider_unauthorized",
        when: "the configured provider rejected the stored credentials.",
      },
      { status: 502, code: "provider_error", when: "the provider could not fulfil the prompt." },
    ],
  }),

  defineEndpoint({
    method: "POST",
    path: "/api/v1/auth/webview-session-token",
    tag: "Auth & pairing",
    summary: "Mint a one-time token to bootstrap a ManagementWebView session",
    description:
      "Mints a short-lived, single-use token bound to the caller's own device session, for " +
      "immediate exchange at `GET /webview-session` inside a `WKWebView` -- lets the native " +
      "client reach the web UI's cookie session without ever handling a password or passkey " +
      "in a webview. See the Auth & pairing overview.",
    auth: "bearer-only",
    response: {
      status: 200,
      schema: z.object({ token: z.string(), expiresAt: z.iso.datetime() }),
      description: "The one-time token and its expiry.",
    },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer device-session token." },
    ],
  }),

  defineEndpoint({
    method: "GET",
    path: "/device/pair",
    tag: "Auth & pairing",
    summary: "Mint a device session and redirect back to the native app",
    description:
      "Reached from `/login`'s `next` parameter after the user signs in through the ordinary " +
      "web form inside the native app's pairing webview. Mints a new device session and " +
      "redirects to `<scheme>://auth-callback?token=...&state=...`, echoing back the caller- " +
      "supplied `state` unchanged -- CSRF protection is the app's own responsibility, not this " +
      "route's. See the Auth & pairing overview for the full pairing flow.",
    auth: "session-cookie",
    request: {
      query: z.object({
        state: z.string().min(1),
        scheme: z.string().optional().describe('Defaults to "yana"; only "yana" is accepted.'),
        deviceName: z.string().optional().describe("Truncated to 64 characters if longer."),
      }),
    },
    response: {
      status: 307,
      schema: null,
      description: "Redirect to the native app's registered custom URL scheme.",
    },
    errors: [
      {
        status: 400,
        code: "(no code -- empty body)",
        when: "state is missing, or scheme is not an allowed scheme.",
      },
    ],
  }),

  defineEndpoint({
    method: "GET",
    path: "/webview-session",
    tag: "Auth & pairing",
    summary: "Exchange a one-time token for a real session cookie",
    description:
      "The `ManagementWebView` landing point: verifies the token minted by " +
      "`POST /api/v1/auth/webview-session-token`, sets a real session cookie for that exact " +
      "device session, and redirects to `next` (validated same-origin, default `/feeds`). Any " +
      "missing, invalid, expired or already-used token falls back to `/login?next=...`, " +
      "indistinguishable from a plain signed-out visit.",
    auth: "one-time-token",
    request: {
      query: z.object({
        token: z.string(),
        next: z.string().optional().describe("A same-origin path; defaults to /feeds."),
      }),
    },
    response: {
      status: 302,
      schema: null,
      description: "Redirect to `next` with the session cookie set, or to /login on failure.",
    },
    errors: [],
  }),
```

- [ ] **Step 2: Run the completeness test — must now be fully green**

Run: `npx vitest run src/lib/api/docs/registry.test.ts`
Expected: PASS, all three assertions.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/api/docs/registry.ts
git commit -m "feat(api-docs): register AI prompt and auth/pairing flow endpoints (registry complete)"
```

---

## Task 6: Narrative content and OpenAPI generation

**Files:**
- Create: `src/lib/api/docs/narrative.ts`
- Create: `src/lib/api/docs/openapi.ts`
- Test: `src/lib/api/docs/openapi.test.ts`

**Interfaces:**
- Produces: `OVERVIEW_MARKDOWN: string`, `TAG_DESCRIPTIONS: Record<string, string>` (from `narrative.ts`); `buildOpenApiDocument(): OpenApiDocument` (from `openapi.ts`, where `OpenApiDocument` is a minimal structural type — `{ openapi: string; info: object; paths: object; tags: object[] }` — not the full `openapi3-ts` type, to avoid a new dependency for typing alone).
- Consumes: `ENDPOINT_REGISTRY` (Task 5), `z.toJSONSchema` (zod 4, already a dependency).

- [ ] **Step 1: Write `narrative.ts`**

```ts
// src/lib/api/docs/narrative.ts

/**
 * English only, by explicit exception -- this is developer reference
 * material, not product UI, so it does not go through messages/en.json or
 * de.json and src/i18n/messages.test.ts's parity check does not apply to it.
 * See the "Global Constraints" section of this feature's implementation plan.
 */
export const OVERVIEW_MARKDOWN = `
# Yana Client API

The versioned HTTP API a native client (or the web UI itself, for images)
uses to read and modify a signed-in user's feeds, tags, articles and AI
configuration. \`v1\` is the only version today.

**Base URL**: this server's own origin, e.g. \`https://yana.example.com\`.

**Errors** always take the shape \`{ "error": { "code": "...", "message": "..." } }\`.
\`code\` is stable and machine-readable; \`message\` is written by the server
for a human and never echoes anything the caller submitted. See the Errors
section below for the full code index.

**Dates** are always ISO 8601 (\`Date.prototype.toISOString()\`).
`.trim();

export const TAG_DESCRIPTIONS: Record<string, string> = {
  "Auth & pairing": `
The native client obtains a device session via \`GET /device/pair\`, reached
from \`/login\`'s \`next\` parameter after the user signs in through the
ordinary web form inside a pairing webview. The resulting Bearer token is
what every other \`/api/v1/**\` route (except \`/device/pair\` itself, which
uses the signed-in web session) accepts in \`Authorization: Bearer <token>\`.

\`state\` is generated by the app and never validated server-side beyond
presence -- CSRF protection is the app's own responsibility (only the
app's own callback handler knows the \`state\` value it's currently
expecting).

\`POST /api/v1/auth/webview-session-token\` + \`GET /webview-session\` is a
second, independent flow: it lets the native client bootstrap the *same*
device session into a \`WKWebView\`'s cookie jar, so \`ManagementWebView\`
can reach the web UI directly without the app ever touching a password or
passkey.
`.trim(),

  Sync: `
\`GET /api/v1/articles/sync\` returns three independently-cursored deltas:
\`new\`, \`updated\`, \`removed\`. The opaque \`cursor\` string encodes a
\`[timestamp, id]\` position per stream; pass back the previous response's
\`nextCursor\` on the next call, or omit it to sync from the beginning.

\`limit\` caps rows *per stream* per call (default 200, clamped to
\`[1, 500]\`) -- a large backlog is paged across multiple calls, each
advancing that stream's cursor independently of the others.

A response of \`{ "resyncRequired": true }\` means the cursor is older than
the server's tombstone-retention horizon: some deletion between the cursor
and now may have already been pruned without a trace, so the client must
discard its local state and sync from the beginning (omit \`cursor\`)
rather than trust a possibly-incomplete \`removed\` list.
`.trim(),

  "Reading position": `
A single cross-device "what article am I reading" pointer per user, backed
by two columns on their settings row -- not a history, just the current
position. \`PATCH\` is last-writer-wins across devices; there is no
conflict resolution beyond "the most recent write's timestamp wins."

Every device with an open \`GET /api/v1/jobs/events\` connection receives a
\`readingPosition\` event immediately after another device's \`PATCH\`, so
open apps can jump live instead of waiting for their next poll of this
endpoint.
`.trim(),

  Jobs: `
\`GET /api/v1/jobs/events\` is a single long-lived Server-Sent-Events
connection carrying three event types for the caller:

- \`job\` -- one background job's status/progress changed.
- \`run\` -- a run's aggregate counters changed (see \`POST /api/v1/aggregate\`).
- \`readingPosition\` -- another device moved the reading-position pointer.

This is a best-effort, low-latency notification layer, not the source of
truth: a dropped connection loses nothing except immediacy. A reconnecting
client should always re-poll \`GET /api/v1/runs/{id}\` (or
\`GET /api/v1/reading-position\`) to recover its actual current state, since
events missed while disconnected are not replayed. The server sends an SSE
comment ping every 15 seconds to keep intermediary proxies from treating a
quiet connection as dead; conforming SSE clients ignore comment lines.
`.trim(),
};
```

- [ ] **Step 2: Write `openapi.ts`**

```ts
// src/lib/api/docs/openapi.ts
import { z } from "zod";

import { ApiErrorSchema } from "./schemas";
import { ENDPOINT_REGISTRY } from "./registry";
import { OVERVIEW_MARKDOWN, TAG_DESCRIPTIONS } from "./narrative";

interface OpenApiOperation {
  summary: string;
  description: string;
  tags: string[];
  parameters?: Array<{ name: string; in: string; required: boolean; schema: unknown }>;
  requestBody?: { required: boolean; content: Record<string, { schema: unknown }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: unknown }> }
  >;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

/** OpenAPI path templates use `{param}`; Next's route segments already match this exactly
 * (see `path` values in `registry.ts`, e.g. `/api/v1/articles/{id}`), so no translation step
 * is needed here. */
function toJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { target: "openapi-3.0" });
}

export function buildOpenApiDocument(): OpenApiDocument {
  const tagNames = [...new Set(ENDPOINT_REGISTRY.map((e) => e.tag))];

  const paths: OpenApiDocument["paths"] = {};
  for (const endpoint of ENDPOINT_REGISTRY) {
    const parameters: OpenApiOperation["parameters"] = [];
    if (endpoint.path.includes("{")) {
      for (const match of endpoint.path.matchAll(/\{(\w+)\}/g)) {
        parameters.push({
          name: match[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        });
      }
    }
    if (endpoint.request?.query) {
      const queryShape = endpoint.request.query as z.ZodObject;
      for (const [name, fieldSchema] of Object.entries(queryShape.shape)) {
        parameters.push({
          name,
          in: "query",
          required: !fieldSchema.isOptional(),
          schema: toJsonSchema(fieldSchema),
        });
      }
    }

    const responses: OpenApiOperation["responses"] = {};
    responses[String(endpoint.response.status)] = {
      description: endpoint.response.description,
      ...(endpoint.response.schema
        ? {
            content: {
              [endpoint.response.contentType ?? "application/json"]: {
                schema: toJsonSchema(endpoint.response.schema),
              },
            },
          }
        : {}),
    };
    for (const err of endpoint.errors) {
      responses[String(err.status)] = {
        description: err.when,
        content: { "application/json": { schema: toJsonSchema(ApiErrorSchema) } },
      };
    }

    const operation: OpenApiOperation = {
      summary: endpoint.summary,
      description: endpoint.description,
      tags: [endpoint.tag],
      responses,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(endpoint.request?.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: toJsonSchema(endpoint.request.body) } },
            },
          }
        : {}),
    };

    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: { title: "Yana Client API", version: "1", description: OVERVIEW_MARKDOWN },
    tags: tagNames.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] ?? "" })),
    paths,
  };
}
```

- [ ] **Step 3: Write `openapi.test.ts`**

```ts
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
```

- [ ] **Step 4: Run the new tests**

Run: `npx vitest run src/lib/api/docs/openapi.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck and the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/api/docs/narrative.ts src/lib/api/docs/openapi.ts src/lib/api/docs/openapi.test.ts
git commit -m "feat(api-docs): generate an OpenAPI 3.1 document from the endpoint registry"
```

---

## Task 7: Committed artifact + drift check script

**Files:**
- Create: `scripts/docs-api.ts`
- Modify: `package.json` (`docs:api`, `docs:api:check` scripts)
- Create (generated): `docs/api/openapi.json`

**Interfaces:**
- Consumes: `buildOpenApiDocument()` (Task 6).

- [ ] **Step 1: Check how existing scripts are invoked, to match conventions**

Run: `cat scripts/seed-feeds.ts | head -5` — confirms whether existing scripts use `tsx` and any shared bootstrap (e.g. a `dotenv` load). Match that shape in the new script.

- [ ] **Step 2: Write `scripts/docs-api.ts`**

```ts
import fs from "node:fs";
import path from "node:path";

import { buildOpenApiDocument } from "@/lib/api/docs/openapi";

const OUTPUT_PATH = path.resolve(__dirname, "../docs/api/openapi.json");

function serialize(): string {
  return JSON.stringify(buildOpenApiDocument(), null, 2) + "\n";
}

function main(): void {
  const mode = process.argv[2];
  const generated = serialize();

  if (mode === "--check") {
    if (!fs.existsSync(OUTPUT_PATH)) {
      console.error(`docs/api/openapi.json is missing. Run "npm run docs:api" to generate it.`);
      process.exit(1);
    }
    const committed = fs.readFileSync(OUTPUT_PATH, "utf8");
    if (committed !== generated) {
      console.error(
        `docs/api/openapi.json is out of date. Run "npm run docs:api" and commit the result.`,
      );
      process.exit(1);
    }
    console.log("docs/api/openapi.json is up to date.");
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, generated);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
```

- [ ] **Step 3: Add the two scripts to `package.json`**

```json
"docs:api": "tsx scripts/docs-api.ts",
"docs:api:check": "tsx scripts/docs-api.ts --check",
```

Add these alongside the existing `aggregator:*` entries.

- [ ] **Step 4: Generate the artifact for the first time**

Run: `npm run docs:api`
Expected: creates `docs/api/openapi.json`.

- [ ] **Step 5: Confirm the drift check passes against the freshly generated file**

Run: `npm run docs:api:check`
Expected: exits 0, prints "docs/api/openapi.json is up to date."

- [ ] **Step 6: Confirm the drift check fails when the registry changes without regenerating (manual smoke test)**

Temporarily edit one `summary` string in `registry.ts`, run `npm run docs:api:check` (expect non-zero exit and the "out of date" message), then revert the edit.

- [ ] **Step 7: Write an automated test proving the check script actually fails on drift**

Create `scripts/docs-api.test.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const OUTPUT_PATH = path.resolve(__dirname, "../docs/api/openapi.json");

describe("docs-api --check", () => {
  it("exits 0 against the currently-committed, up-to-date file", () => {
    expect(() =>
      execFileSync("npx", ["tsx", "scripts/docs-api.ts", "--check"], {
        cwd: path.resolve(__dirname, ".."),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("exits non-zero when the committed file is stale", () => {
    const original = fs.readFileSync(OUTPUT_PATH, "utf8");
    fs.writeFileSync(OUTPUT_PATH, original.replace('"openapi": "3.1.0"', '"openapi": "0.0.0"'));
    try {
      expect(() =>
        execFileSync("npx", ["tsx", "scripts/docs-api.ts", "--check"], {
          cwd: path.resolve(__dirname, ".."),
          stdio: "pipe",
        }),
      ).toThrow();
    } finally {
      fs.writeFileSync(OUTPUT_PATH, original);
    }
  });
});
```

The `finally` restores the committed file unconditionally, so a failed assertion mid-test can't leave `docs/api/openapi.json` corrupted for the next run.

- [ ] **Step 8: Run the new test**

Run: `npx vitest run scripts/docs-api.test.ts`
Expected: PASS (both cases — the file is restored either way)

- [ ] **Step 9: Add `docs:api:check` to the CI command line**

Find where CI runs `lint`/`format:check`/`typecheck`/`test` (likely `.github/workflows/*.yml` or a CI config file — locate it with `grep -rl "format:check" .github 2>/dev/null || grep -rl "format:check" .gitlab-ci.yml 2>/dev/null`) and add `npm run docs:api:check` to the same step or job, after `typecheck` and before `test` (cheapest-first ordering, matching the existing sequence).

- [ ] **Step 10: Commit**

```bash
git add scripts/docs-api.ts scripts/docs-api.test.ts package.json docs/api/openapi.json \
  <the CI config file>
git commit -m "feat(api-docs): commit generated openapi.json with a CI drift check"
```

---

## Task 8: `openapi.json` route + `/api-docs` page

**Files:**
- Create: `src/app/api/v1/openapi.json/route.ts`
- Create: `src/app/(app)/api-docs/page.tsx`
- Test: `src/app/(app)/api-docs/page.test.tsx`
- Modify: `src/lib/nav.ts`
- Modify: `messages/en.json`, `messages/de.json`
- Modify: `package.json` (new dependency)

**Interfaces:**
- Consumes: `buildOpenApiDocument()` (Task 6), `requireUser()` (`@/lib/auth/session`, existing), `UNLISTED_ROUTES` (`@/lib/nav.ts`, existing).

- [ ] **Step 1: Add the pinned dependency**

Run: `npm install --save-exact @scalar/nextjs-api-reference@0.11.14`
Then grep both files for stray ranges: `grep -n '"@scalar' package.json package-lock.json` — confirm no `^`/`~`.

- [ ] **Step 2: Write the `openapi.json` route handler**

```ts
// src/app/api/v1/openapi.json/route.ts
import { connection } from "next/server";

import { buildOpenApiDocument } from "@/lib/api/docs/openapi";
import { requireUser } from "@/lib/auth/session";

/**
 * The generated OpenAPI document, signed-in only -- gated the same way
 * `src/app/media/avatars/[userId]/route.ts` gates itself, since a route
 * handler has no layout above it enforcing anything. `requireUser()`
 * redirects a signed-out caller to /login rather than answering 401, exactly
 * like the rest of `(app)` -- this is documentation reachable from inside the
 * app, not a `/api/v1/**` data endpoint, so it does not go through
 * `requireApiUser()`'s Bearer-or-cookie contract.
 *
 * `await connection()` is the literal first statement, ahead of
 * `requireUser()` -- see the `connection()` bullet in the root CLAUDE.md.
 */
export async function GET(): Promise<Response> {
  await connection();
  await requireUser();
  return Response.json(buildOpenApiDocument());
}
```

- [ ] **Step 3: Write the `/api-docs` page**

```tsx
// src/app/(app)/api-docs/page.tsx
import { connection } from "next/server";

import { ApiReference } from "@scalar/nextjs-api-reference";

import { requireUser } from "@/lib/auth/session";

/**
 * `await connection()` is the literal first statement, ahead of
 * `requireUser()` -- see the `connection()` bullet in the root CLAUDE.md.
 * `(app)`'s own layout already awaits `requireUser()` before this page
 * renders, but this route reads no other Dynamic API on its own path, so it
 * still needs its own opt-out (see the CLAUDE.md list of the eight routes
 * that call `connection()` themselves).
 */
export default async function ApiDocsPage() {
  await connection();
  await requireUser();

  return <ApiReference configuration={{ url: "/api/v1/openapi.json" }} />;
}
```

- [ ] **Step 4: Add the route to `UNLISTED_ROUTES` in `src/lib/nav.ts`**

```ts
const UNLISTED_ROUTES: readonly { href: string; labelKey: NavLabelKey }[] = [
  { href: "/account", labelKey: "nav.account" },
  { href: "/api-docs", labelKey: "nav.apiDocs" },
];
```

- [ ] **Step 5: Add the `nav.apiDocs` catalog key to both message files**

In `messages/en.json`, inside `"nav"`:
```json
"apiDocs": "API Docs"
```
In `messages/de.json`, inside `"nav"` (match its existing German equivalents for the other keys):
```json
"apiDocs": "API-Dokumentation"
```

- [ ] **Step 6: Run the i18n parity test**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS

- [ ] **Step 7: Link the page from `/settings`'s About section**

Edit `src/components/settings/about-section.tsx`, adding a third `<li>` alongside the existing source/issues links:

```tsx
<li>
  <a className="underline" href="/api-docs">
    {t("about.apiDocs")}
  </a>
</li>
```

Add `"apiDocs": "API documentation"` to `messages/en.json`'s `settings.about` object and its German equivalent (e.g. `"API-Dokumentation"`) to `messages/de.json`'s.

- [ ] **Step 8: Update `about-section.test.tsx`**

Find the existing test asserting the source/issues links render (`src/components/settings/about-section.test.tsx`) and add a parallel assertion for the new link's `href="/api-docs"` and its translated text, following that file's existing pattern exactly (read the file first — do not guess its structure).

- [ ] **Step 9: Write `api-docs/page.test.tsx`**

```tsx
// src/app/(app)/api-docs/page.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "user-1" }),
}));

vi.mock("@scalar/nextjs-api-reference", () => ({
  ApiReference: ({ configuration }: { configuration: { url: string } }) => (
    <div data-testid="scalar-reference">{configuration.url}</div>
  ),
}));

import ApiDocsPage from "./page";

describe("ApiDocsPage", () => {
  it("renders the reference viewer pointed at the generated spec", async () => {
    render(await ApiDocsPage());
    expect(screen.getByTestId("scalar-reference")).toHaveTextContent("/api/v1/openapi.json");
  });
});
```

Note: this test stubs `@scalar/nextjs-api-reference` entirely — per the repo's own testing convention, this is a router/session-shaped stub of an external viewer, not a database mock, and is in-bounds the same way `next/navigation` stubs are.

- [ ] **Step 10: Run the new test and the full dom project**

Run: `npx vitest run src/app/\(app\)/api-docs/page.test.tsx src/components/settings/about-section.test.tsx`
Expected: PASS

- [ ] **Step 11: Run lint, format check, typecheck, and the full test suite**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: PASS. If `format:check` fails, run `npm run format` and re-check.

- [ ] **Step 12: Manual verification in the dev server**

Run: `npm run dev`, sign in, navigate to `/api-docs`, and confirm the rendered reference lists all 16 endpoints grouped by tag with the narrative descriptions visible, an example request/response where declared, and that `/api/v1/openapi.json` redirects to `/login` when visited signed-out in a private window.

- [ ] **Step 13: Commit**

```bash
git add src/app/api/v1/openapi.json/route.ts src/app/\(app\)/api-docs/ src/lib/nav.ts \
  messages/en.json messages/de.json src/components/settings/about-section.tsx \
  src/components/settings/about-section.test.tsx package.json package-lock.json
git commit -m "feat(api-docs): render the OpenAPI document at /api-docs via Scalar"
```

---

## Final Verification

- [ ] Run the complete CI-equivalent command line once more end to end:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run docs:api:check
```

Expected: all pass, confirming the registry, the committed `openapi.json`, and every modified file are mutually consistent.

- [ ] Confirm no stray `^`/`~` crept into `package.json` or `package-lock.json`:

```bash
grep -n '"@scalar' package.json package-lock.json
```

Expected: exact `0.11.14` pin in both, no range operators.
