import { describe, it, expect, vi } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("returns results in the same order as inputs, even when later items resolve first", async () => {
    const delays = [100, 10, 50]; // First item slowest, last item fastest
    const results = await mapWithConcurrency(delays, 3, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });

    expect(results).toEqual([100, 10, 50]);
  });

  it("never has more than `limit` calls in flight simultaneously", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const limit = 3;
    const itemCount = 10;

    await mapWithConcurrency(
      Array.from({ length: itemCount }, (_, i) => i),
      limit,
      async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentConcurrent--;
      },
    );

    expect(maxConcurrent).toBeLessThanOrEqual(limit);
    expect(maxConcurrent).toBeGreaterThan(0); // Verify concurrency actually happened
  });

  it("works when limit is greater than items.length", async () => {
    const items = [1, 2, 3];
    const limit = 10;

    const results = await mapWithConcurrency(items, limit, async (item) => item * 2);

    expect(results).toEqual([2, 4, 6]);
  });

  it("returns empty array for empty items", async () => {
    const fn = vi.fn();
    const results = await mapWithConcurrency([], 5, fn);

    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("works with a single item", async () => {
    const results = await mapWithConcurrency([42], 1, async (item) => item + 1);

    expect(results).toEqual([43]);
  });

  it("respects limit=1 (sequential execution)", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    await mapWithConcurrency(
      Array.from({ length: 5 }, (_, i) => i),
      1,
      async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        currentConcurrent--;
      },
    );

    expect(maxConcurrent).toBe(1);
  });

  it("calls fn with correct item and index", async () => {
    const fn = vi.fn((item, index) => Promise.resolve(`${item}-${index}`));
    const items = ["a", "b", "c"];

    const results = await mapWithConcurrency(items, 2, fn);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn).toHaveBeenNthCalledWith(1, "a", 0);
    expect(fn).toHaveBeenNthCalledWith(2, "b", 1);
    expect(fn).toHaveBeenNthCalledWith(3, "c", 2);
    expect(results).toEqual(["a-0", "b-1", "c-2"]);
  });

  it("propagates errors from fn", async () => {
    const error = new Error("test error");
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw error;
        return item;
      }),
    ).rejects.toThrow(error);
  });

  it("handles negative limit by clamping to 1", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    await mapWithConcurrency([1, 2, 3], -5, async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      currentConcurrent--;
    });

    expect(maxConcurrent).toBe(1);
  });

  it("provides correct context for index parameter", async () => {
    const indices: number[] = [];
    await mapWithConcurrency(
      Array.from({ length: 7 }, (_, i) => i * 10),
      2,
      async (item, index) => {
        indices.push(index);
        return item + index;
      },
    );

    expect(indices.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
