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
    runs: [{ text: "Head", bold: true, italic: false, code: false, strikethrough: false, link: "" }],
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

    expect(roots.map((r) => r.position)).toEqual(
      Array.from({ length: TREE.length }, (_, i) => i),
    );
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
});
