import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

import { ADMIN_ROLE, ADMIN_ROLES, isAdminRole } from "./roles";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * `isAdminRole()` is the whole authorization model -- the only predicate
 * `requireAdmin()`, the sidebar's admin-only items and the admin bootstrap ask
 * -- and until this file existed, mutating it to `return true` failed 3 of 351
 * tests. That is not coverage of an authorization decision; that is three tests
 * that happened to render a non-admin sidebar.
 *
 * Two properties are pinned here, and the second is the one that matters.
 */
describe("the roles module's dependency contract", () => {
  /**
   * `roles.ts` says it imports nothing "and must stay that way". That was a
   * comment, unlike the equivalent rules on `src/proxy.ts` and
   * `src/instrumentation.ts`, which are tripwires. It is now one too.
   *
   * The rule is not tidiness. This module is read from the jsdom component
   * tests and from `src/app/(app)/layout.test.tsx`, which stubs the *session*
   * and then calls the **real** predicate -- so a test cannot drift from
   * production by reimplementing it. One import of `./server` would drag
   * `better-sqlite3` into every one of those, and into any client component a
   * later phase writes.
   */
  it("imports nothing at all", () => {
    const source = fs
      .readFileSync(path.join(ROOT, "src/lib/auth/roles.ts"), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const specifiers = [
      ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);

    expect(specifiers).toEqual([]);
  });

  it("still names `admin` as the one administrative role", () => {
    expect(ADMIN_ROLE).toBe("admin");
    expect(ADMIN_ROLES).toEqual(["admin"]);
  });
});

/**
 * Every value that has to answer, including the two the type allows and no
 * test exercised: Better Auth types `role` as optional even though the column
 * is `NOT NULL`, so the null branch exists on purpose and was unpinned.
 *
 * The comma cases are the phase-4 review's finding. `/admin/set-role` accepted
 * an arbitrary array, so `"user,admin"` is a value the library itself can put
 * in the column -- and the plugin reads it as a list.
 */
const CASES: [role: string | null | undefined, isAdmin: boolean, why: string][] = [
  ["admin", true, "the plain administrative role"],
  ["user", false, "the plain default role"],
  ["", false, "an empty string is not a role"],
  [null, false, "Better Auth types role as optional; a missing one is not admin"],
  [undefined, false, "same, for an absent property"],
  ["user,admin", true, "a comma list the plugin grants on"],
  ["admin,user", true, "order does not matter to the plugin's split"],
  ["admin,admin", true, "a repeated part is still a part"],
  ["administrator", false, "a longer word that merely starts with the role"],
  ["superadmin", false, "a longer word that merely ends with it"],
  ["Admin", false, "the plugin indexes its role map case-sensitively"],
  ["user,editor", false, "a list with no administrative part"],
  [",", false, "two empty parts"],
  // Not trimmed, deliberately: `has-permission.mjs` does a bare `.split(",")`
  // and indexes the result, so a space makes the part `" admin"`, which the
  // plugin does not grant on either. Trimming here would make this application
  // the *more* permissive of the two -- the exact drift the split fixes.
  ["user, admin", false, "an untrimmed part, matching the plugin byte for byte"],
];

describe("isAdminRole", () => {
  it.each(CASES)("%j is %s -- %s", (role, expected) => {
    expect(isAdminRole(role)).toBe(expected);
  });
});

/**
 * **The agreement itself, checked against the library rather than restated.**
 *
 * The point of `isAdminRole()` is that this application and the `admin()`
 * plugin cannot disagree about who is an administrator. A table of expectations
 * written by hand proves only that the function matches what its author
 * believed the plugin does -- which is precisely the mistake the exact-equality
 * version was. So every case above is replayed through the plugin's own
 * `/admin/has-permission` handler, whose answer comes from the real
 * `hasPermission()` in `better-auth/dist/plugins/admin/has-permission.mjs`.
 *
 * `auth.api.*` reaches the endpoint directly, which is why closing every
 * `/admin/*` path in `disabledPaths` does not blind this test: `disabledPaths`
 * gates HTTP routing only.
 *
 * The permission asked for is `user: ["set-role"]`, which the plugin's default
 * `adminAc` grants to `admin` and to nobody else.
 */
describe("isAdminRole agrees with the admin() plugin's own role parsing", () => {
  let dbPath: string;
  let auth: typeof import("./server").auth;
  let client: typeof import("@/lib/db/client");

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `yana-roles-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";
    ({ auth } = await import("./server"));
    client = await import("@/lib/db/client");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  // `null`, `undefined` and `""` are excluded: the endpoint refuses a falsy
  // role with "user id or role is required" before it reaches `hasPermission()`
  // at all, so there is no plugin answer to compare against. Those branches
  // exist for a session object rather than for the column, and the table above
  // covers them.
  it.each(CASES.filter(([role]) => typeof role === "string" && role !== ""))(
    "%j: the plugin and isAdminRole() give the same answer",
    async (role, expected) => {
      // Cast because the plugin's *types* narrow `role` to `"admin" | "user"`
      // while its Zod body schema is a bare `z.string()` -- which is the gap
      // this whole file exists for: the column really can hold "user,admin".
      const { success } = await auth.api.userHasPermission({
        body: { role, permissions: { user: ["set-role"] } } as never,
      });

      expect(success).toBe(expected);
      expect(isAdminRole(role)).toBe(success);
    },
  );
});
