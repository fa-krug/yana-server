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
  status: z.enum(["running", "completed", "failed"]),
  progress: z.number().int().min(0).max(100),
  totalJobs: z.number().int(),
  completedJobs: z.number().int(),
  failedJobs: z.number().int(),
});

export const JobSchema = z.object({
  jobId: z.number().int(),
  runId: z.number().int().nullable(),
  kind: z.string(),
  progress: z.number().int().min(0).max(100),
  status: z.enum(["pending", "running", "cancelling", "completed", "failed", "cancelled"]),
  error: z.string(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
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
    z.object({ type: z.literal("summary"), blocks: z.array(WireBlockSchema) }),
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

// Kept in sync with ApiEventPayloadSchema below by hand -- registry.ts (the
// only thing that actually feeds the OpenAPI generator) imports the payload
// union, never this one, so nothing catches the two drifting apart the way
// the generated-doc test catches every schema `registry.ts` does reference.
// This shape previously omitted `progress` from the "run" variant after it
// was added to ApiEventPayloadSchema and RunSchema; nothing failed, because
// nothing reads this schema at all beyond the prose comment below. Since
// there is no current import of ApiEventSchema outside this file, it should
// probably be deleted in favor of describing the three event shapes directly
// from ApiEventPayloadSchema (or documented in prose only) -- left in place
// for this pass since removing it is a separate decision, not a fix for the
// bug reported here.
export const ApiEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("job"),
    payload: z.object({
      jobId: z.number().int(),
      runId: z.number().int().nullable(),
      kind: z.string(),
      status: z.string(),
      progress: z.number().int().min(0).max(100),
    }),
  }),
  z.object({
    type: z.literal("run"),
    payload: z.object({
      runId: z.number().int(),
      status: z.string(),
      progress: z.number().int().min(0).max(100),
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

/**
 * The bare payload union `GET /api/v1/jobs/events` actually sends in each SSE
 * `data:` frame -- the three shapes above, minus the `{ type, payload }`
 * wrapper. The route's `send(event.type, event.payload)` puts `type` in the
 * SSE `event:` line and JSON-encodes only `payload` in `data:`; `ApiEventSchema`
 * above is a correct description of the logical event (useful for narrative
 * prose) but not of what crosses the wire in any single frame, so the registry
 * documents the response with this schema instead.
 */
export const ApiEventPayloadSchema = z.union([
  z.object({
    jobId: z.number().int(),
    runId: z.number().int().nullable(),
    kind: z.string(),
    status: z.string(),
    progress: z.number().int().min(0).max(100),
  }),
  z.object({
    runId: z.number().int(),
    status: z.string(),
    progress: z.number().int().min(0).max(100),
    totalJobs: z.number().int(),
    completedJobs: z.number().int(),
    failedJobs: z.number().int(),
  }),
  z.object({
    articleId: z.number().int(),
    updatedAt: z.iso.datetime(),
  }),
]);

// Request bodies -- imported by the routes themselves, not duplicated there,
// so the schema the docs describe and the schema a route validates against
// are the same object.
export const ReadingPositionPatchBodySchema = z.object({ articleId: z.number().int() });

export const ArticlePatchBodySchema = z
  .object({ starred: z.boolean().optional(), read: z.boolean().optional() })
  .refine((body) => body.starred !== undefined || body.read !== undefined, {
    message: "Provide starred and/or read.",
  });
