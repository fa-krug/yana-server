/**
 * TEST-ONLY: shared setup for the `node` vitest project.
 *
 * One job today: neutralize the aggregators' per-host request gap. Every fetch
 * in `src/lib/aggregators/**` now goes through `withHostLimit()`
 * (`src/lib/aggregators/http/host-limiter.ts`), whose production defaults space
 * requests to one host half a second apart. That is the point in production and
 * pure cost here -- the suite's fetches are all mocked and return instantly, so
 * the gap would buy nothing but wall-clock, several seconds at a time in the
 * files that drive a dozen articles through `enrichArticles()`.
 *
 * `maxConcurrent` is deliberately left at its real value: it costs nothing
 * against instant mocks, and zeroing it would mean no test ever exercised the
 * cap. `host-limiter.test.ts` sets its own limits per case and so is unaffected
 * by either choice.
 */
import { beforeEach } from "vitest";

import { resetHostLimits } from "@/lib/aggregators/http/host-limiter";

beforeEach(() => {
  resetHostLimits({ minGapMs: 0, defaultCooldownMs: 0 });
});
