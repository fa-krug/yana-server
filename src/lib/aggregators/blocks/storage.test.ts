import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

import type { Block } from "./types";

const TREE: Block[] = [
  {
    kind: "heading",
    level: 3,
    runs: [
      { text: "Head", bold: true, italic: false, code: false, strikethrough: false, link: "" },
    ],
  },
  {
    kind: "paragraph",
    runs: [
      { text: "Body ", bold: false, italic: false, code: false, strikethrough: false, link: "" },
      {
        text: "link",
        bold: false,
        italic: false,
        code: false,
        strikethrough: false,
        link: "https://x/",
      },
    ],
  },
  {
    kind: "list",
    ordered: true,
    items: [
      [
        {
          kind: "paragraph",
          runs: [
            {
              text: "one",
              bold: false,
              italic: false,
              code: false,
              strikethrough: false,
              link: "",
            },
          ],
        },
      ],
      [
        {
          kind: "paragraph",
          runs: [
            {
              text: "two",
              bold: false,
              italic: false,
              code: false,
              strikethrough: false,
              link: "",
            },
          ],
        },
        {
          kind: "list",
          ordered: false,
          items: [
            [
              {
                kind: "paragraph",
                runs: [
                  {
                    text: "deep",
                    bold: false,
                    italic: false,
                    code: false,
                    strikethrough: false,
                    link: "",
                  },
                ],
              },
            ],
          ],
        },
      ],
    ],
  },
  {
    kind: "blockquote",
    blocks: [
      {
        kind: "paragraph",
        runs: [
          {
            text: "quoted",
            bold: false,
            italic: true,
            code: false,
            strikethrough: false,
            link: "",
          },
        ],
      },
    ],
  },
  {
    kind: "image",
    ref: "yana-img://" + "a".repeat(64),
    caption: [
      { text: "cap", bold: false, italic: false, code: false, strikethrough: false, link: "" },
    ],
  },
  {
    kind: "embed",
    provider: "video",
    externalUrl: "https://v/x.mp4",
    thumbnailRef: "yana-img://" + "b".repeat(64),
    title: "Clip",
  },
  {
    kind: "code_block",
    text: "x = 1\n",
    language: "",
  },
  {
    kind: "divider",
  },
];

describe("block storage", () => {
  let dbPath: string;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let storage: typeof import("./storage");
  let articleId: number;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    vi.resetModules();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-block-storage-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;

    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    storage = await import("./storage");

    // Seed feed and article
    articleId = client.writeTransaction((tx) => {
      const user = tx
        .insert(schema.users)
        .values({
          id: `user-${stamp}`,
          email: `user-${stamp}@example.com`,
          name: "Test User",
        })
        .returning()
        .get();

      const feed = tx
        .insert(schema.feeds)
        .values({
          name: "Test Feed",
          userId: user.id,
        })
        .returning()
        .get();

      const art = tx
        .insert(schema.articles)
        .values({
          name: "Test Article",
          identifier: `art-${stamp}`,
          date: new Date(),
          feedId: feed.id,
        })
        .returning()
        .get();

      return art.id;
    });
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("reads back a block tree identically", async () => {
    await storage.writeBlocks(articleId, TREE);
    const loaded = await storage.readBlocks(articleId);
    expect(loaded).toEqual(TREE);
  });

  it("reads back a summary block with its children", async () => {
    const tree: Block[] = [
      {
        kind: "summary",
        blocks: [
          {
            kind: "paragraph",
            runs: [
              {
                text: "The gist.",
                bold: false,
                italic: false,
                code: false,
                strikethrough: false,
                link: "",
              },
            ],
          },
        ],
      },
      {
        kind: "paragraph",
        runs: [
          {
            text: "Body.",
            bold: false,
            italic: false,
            code: false,
            strikethrough: false,
            link: "",
          },
        ],
      },
    ];

    await storage.writeBlocks(articleId, tree);
    expect(await storage.readBlocks(articleId)).toEqual(tree);

    // Stored as a parent row plus its own child rows, the same shape a
    // blockquote takes -- not flattened into the root sequence.
    const rows = client
      .getDb()
      .select()
      .from(schema.articleBlocks)
      .where(eq(schema.articleBlocks.articleId, articleId))
      .all();
    const summaryRow = rows.find((row) => row.kind === "summary");
    expect(summaryRow).toBeDefined();
    expect(summaryRow!.parentId).toBeNull();
    expect(summaryRow!.position).toBe(0);
    expect(rows.filter((row) => row.parentId === summaryRow!.id)).toHaveLength(1);
  });

  it("returns row count matching written article blocks in DB", async () => {
    const written = await storage.writeBlocks(articleId, TREE);
    const db = client.getDb();
    const rows = db
      .select()
      .from(schema.articleBlocks)
      .where(eq(schema.articleBlocks.articleId, articleId))
      .all();
    expect(written).toBe(rows.length);
  });

  it("countBlockRows predicts row count of a real write", async () => {
    const predicted = storage.countBlockRows(TREE);
    const actual = await storage.writeBlocks(articleId, TREE);
    expect(predicted).toBe(actual);
  });

  it("stores list items as synthetic list_item rows", async () => {
    const tree: Block[] = [
      {
        kind: "list",
        ordered: false,
        items: [
          [
            {
              kind: "paragraph",
              runs: [
                {
                  text: "a",
                  bold: false,
                  italic: false,
                  code: false,
                  strikethrough: false,
                  link: "",
                },
              ],
            },
          ],
        ],
      },
    ];

    await storage.writeBlocks(articleId, tree);

    const db = client.getDb();
    const rows = db
      .select({ kind: schema.articleBlocks.kind })
      .from(schema.articleBlocks)
      .where(eq(schema.articleBlocks.articleId, articleId))
      .all();

    const kinds = rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["list", "list_item", "paragraph"]);
  });

  it("links children to parent primary key", async () => {
    const tree: Block[] = [
      {
        kind: "blockquote",
        blocks: [
          {
            kind: "paragraph",
            runs: [
              {
                text: "a",
                bold: false,
                italic: false,
                code: false,
                strikethrough: false,
                link: "",
              },
            ],
          },
        ],
      },
    ];

    await storage.writeBlocks(articleId, tree);

    const db = client.getDb();
    const blockquoteRow = db
      .select()
      .from(schema.articleBlocks)
      .where(eq(schema.articleBlocks.kind, "blockquote"))
      .get()!;

    const paragraphRow = db
      .select()
      .from(schema.articleBlocks)
      .where(eq(schema.articleBlocks.kind, "paragraph"))
      .get()!;

    expect(paragraphRow.parentId).toBe(blockquoteRow.id);
  });

  it("assigns sequential root positions", async () => {
    await storage.writeBlocks(articleId, TREE);

    const db = client.getDb();
    const roots = db
      .select()
      .from(schema.articleBlocks)
      .where(eq(schema.articleBlocks.articleId, articleId))
      .all()
      .filter((r) => r.parentId === null)
      .sort((a, b) => a.position - b.position);

    expect(roots.map((r) => r.position)).toEqual(Array.from({ length: TREE.length }, (_, i) => i));
  });

  it("rewriting replaces previous tree completely", async () => {
    await storage.writeBlocks(articleId, TREE);
    await storage.writeBlocks(articleId, [{ kind: "divider" }]);

    const loaded = await storage.readBlocks(articleId);
    expect(loaded).toEqual([{ kind: "divider" }]);

    const db = client.getDb();
    const blocks = db
      .select()
      .from(schema.articleBlocks)
      .where(eq(schema.articleBlocks.articleId, articleId))
      .all();
    expect(blocks.length).toBe(1);

    const runs = db.select().from(schema.articleInlineRuns).all();
    expect(runs.length).toBe(0);
  });

  it("writing empty block array clears tree", async () => {
    await storage.writeBlocks(articleId, TREE);
    const count = await storage.writeBlocks(articleId, []);
    expect(count).toBe(0);

    const loaded = await storage.readBlocks(articleId);
    expect(loaded).toEqual([]);
  });

  it("loadBlocksForArticles handles unknown articleId by returning empty array", async () => {
    const unknownId = articleId + 999;
    const res = await storage.loadBlocksForArticles([unknownId]);
    expect(res).toEqual({ [unknownId]: [] });
  });

  it("reads back list whose child rows are not list_item (malformed nesting tolerance)", async () => {
    const tree: Block[] = [
      {
        kind: "list",
        ordered: false,
        items: [
          [
            {
              kind: "paragraph",
              runs: [
                {
                  text: "a",
                  bold: false,
                  italic: false,
                  code: false,
                  strikethrough: false,
                  link: "",
                },
              ],
            },
          ],
        ],
      },
    ];

    await storage.writeBlocks(articleId, tree);

    const db = client.getDb();
    const listItemRow = db
      .select()
      .from(schema.articleBlocks)
      .where(eq(schema.articleBlocks.kind, "list_item"))
      .get()!;

    db.update(schema.articleBlocks)
      .set({ kind: "paragraph" })
      .where(eq(schema.articleBlocks.id, listItemRow.id))
      .run();

    const loaded = await storage.readBlocks(articleId);
    expect(loaded[0].kind).toBe("list");
    const listBlock = loaded[0] as Extract<Block, { kind: "list" }>;
    expect(listBlock.items.length).toBe(1);
    expect(listBlock.items[0].length).toBe(1);
  });

  it("skips stray root-level list_item row", async () => {
    const tree: Block[] = [
      {
        kind: "paragraph",
        runs: [
          { text: "a", bold: false, italic: false, code: false, strikethrough: false, link: "" },
        ],
      },
    ];

    await storage.writeBlocks(articleId, tree);

    const db = client.getDb();
    db.update(schema.articleBlocks)
      .set({ kind: "list_item" })
      .where(eq(schema.articleBlocks.articleId, articleId))
      .run();

    const loaded = await storage.readBlocks(articleId);
    expect(loaded).toEqual([]);
  });

  it("writes a tree spanning many insert batches without exceeding SQLite's variable limit", async () => {
    // A long-form scraped article can produce thousands of paragraphs/runs; writeBlocks batches
    // its bulk inserts (SQL_VARIABLE_BATCH_SIZE = 100) so this never hits "too many SQL variables".
    const PARAGRAPH_COUNT = 6000;
    const tree: Block[] = Array.from({ length: PARAGRAPH_COUNT }, (_, i) => ({
      kind: "paragraph",
      runs: [
        {
          text: `p${i}`,
          bold: false,
          italic: false,
          code: false,
          strikethrough: false,
          link: "",
        },
      ],
    }));

    const written = await storage.writeBlocks(articleId, tree);
    expect(written).toBe(PARAGRAPH_COUNT);

    const loaded = await storage.readBlocks(articleId);
    expect(loaded).toEqual(tree);

    const db = client.getDb();
    const roots = db
      .select()
      .from(schema.articleBlocks)
      .where(eq(schema.articleBlocks.articleId, articleId))
      .all()
      .sort((a, b) => a.position - b.position);
    expect(roots.map((r) => r.position)).toEqual(
      Array.from({ length: PARAGRAPH_COUNT }, (_, i) => i),
    );
  });

  /**
   * Task 5 (2026-09-03 pipeline review 3): the write side has always chunked
   * its bulk inserts (SQL_VARIABLE_BATCH_SIZE) to survive
   * SQLITE_MAX_VARIABLE_NUMBER, but `loadBlocksForArticles` used to bind
   * every block id in one unchunked `inArray` -- so an article the batched
   * insert wrote successfully could throw "too many SQL variables" reading
   * itself back out, on the very SQLite build the write side already
   * defends against. This repository's own better-sqlite3 build compiles
   * MAX_VARIABLE_NUMBER=32766 (confirmed live), so this count is chosen to
   * exceed it -- on unchunked code this test fails with exactly that SQLite
   * error; chunked, both the insert and the read-back succeed.
   */
  it("reads back an article whose block count exceeds SQLite's compiled variable limit", async () => {
    const BLOCK_COUNT = 33_000;
    const tree: Block[] = Array.from({ length: BLOCK_COUNT }, () => ({ kind: "divider" }));

    const written = await storage.writeBlocks(articleId, tree);
    expect(written).toBe(BLOCK_COUNT);

    const loaded = await storage.readBlocks(articleId);
    expect(loaded.length).toBe(BLOCK_COUNT);
    expect(loaded[0]).toEqual({ kind: "divider" });
  });

  it("preserves empty list items", async () => {
    const tree: Block[] = [
      {
        kind: "list",
        ordered: false,
        items: [
          [
            {
              kind: "paragraph",
              runs: [
                {
                  text: "a",
                  bold: false,
                  italic: false,
                  code: false,
                  strikethrough: false,
                  link: "",
                },
              ],
            },
          ],
          [],
        ],
      },
    ];

    await storage.writeBlocks(articleId, tree);
    const loaded = await storage.readBlocks(articleId);
    expect(loaded).toEqual(tree);
  });

  it("threads the article's own id onto every row at every depth", async () => {
    await storage.writeBlocks(articleId, TREE);

    const rows = client.getDb().select().from(schema.articleBlocks).all();

    // The fixture nests three levels deep (list -> list_item -> list), so this
    // exercises the threading, not just the root insert.
    expect(rows.some((row) => row.parentId !== null)).toBe(true);
    for (const row of rows) {
      expect(row.articleId).toBe(articleId);
    }
  });

  it("indexes embedThumbnailRef for the images ownership query, not embedProvider", () => {
    const names = raw(client.getDb())
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'article_blocks'`,
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("article_blocks_embed_thumbnail_ref_idx");
    expect(names).not.toContain("article_blocks_embed_provider_idx");
  });

  it("refuses two runs at the same (blockId, position)", async () => {
    await storage.writeBlocks(articleId, TREE);

    const firstRun = client.getDb().select().from(schema.articleInlineRuns).all()[0];
    expect(firstRun).toBeDefined();

    expect(() =>
      client.writeTransaction((tx) => {
        tx.insert(schema.articleInlineRuns)
          .values({ blockId: firstRun.blockId, position: firstRun.position, text: "dup" })
          .run();
      }),
    ).toThrow(/UNIQUE|PRIMARY/i);
  });
});
