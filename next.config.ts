import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const config: NextConfig = {
  // The Docker image copies .next/standalone; without this the image would
  // need the full node_modules tree.
  output: "standalone",
  // Without this pin, Next infers the workspace root by walking up from this
  // directory and picking the topmost ancestor that has a lockfile -- which
  // can be a completely unrelated lockfile that happens to sit above the
  // checkout (e.g. in a developer's home directory), and then nests the
  // entire absolute path under .next/standalone instead of putting
  // server.js at its root. The Dockerfile's
  // `COPY --from=builder /build/.next/standalone ./` and its
  // `CMD ["node", "server.js"]` both assume server.js lands at the tree
  // root, so pin the root to this project directory explicitly rather than
  // leaving it to be inferred from whatever happens to be above the build
  // directory on a given machine.
  outputFileTracingRoot: __dirname,
  // better-sqlite3 is a native addon. Bundling it breaks the .node binding
  // resolution, so it must stay external and be require()d at runtime.
  //
  // This covers the *node* server bundle only. The edge layer needs the
  // separate treatment below -- do not assume this line protects both.
  serverExternalPackages: ["better-sqlite3"],

  /**
   * Cut the startup module out of the **edge** compilation.
   *
   * Webpack builds `src/instrumentation.ts` for both runtimes and resolves its
   * imports statically -- including a dynamic `import()` sitting inside a
   * `process.env.NEXT_RUNTIME !== "nodejs"` guard, because that guard is a
   * *runtime* check and the graph is already resolved by then. (Next's own
   * instrumentation guide prescribes exactly that guard-plus-dynamic-import
   * shape, so this is a bundler gap, not a misuse.) The edge layer therefore
   * pulls in `@/lib/startup` -> `@/lib/db/client` -> `node:fs` and
   * `better-sqlite3`, neither of which exists there, and the compilation fails.
   * In `next dev` that surfaces as a **500 on every route** -- with a healthy
   * database and a working node-side bootstrap behind it, which is what makes
   * it so easy to miss: `next build` does not hit it (it emits the edge
   * instrumentation hook only when edge routes exist, and this app has none),
   * `next start` does not either, and Turbopack compiles it fine.
   * `serverExternalPackages` above does not help; it governs the node bundle.
   *
   * Cutting the *module* rather than `better-sqlite3` alone is deliberate:
   * `db/client.ts` imports `node:fs` and `node:path` directly, so excluding the
   * driver only moves the error one line down (measured -- the next failure is
   * `UnhandledSchemeError: Reading from "node:fs"`). Ignoring the module is
   * also honest about what the edge layer may do, which is nothing: the only
   * importer is dead code behind the runtime guard. Marking it external instead
   * would emit a `require()` into a bundle that has none, trading a compile
   * error for a runtime one.
   *
   * The single specifier is the contract with `src/instrumentation.ts`: it
   * imports `@/lib/startup` and nothing else, so this stays one regexp instead
   * of a list that the next startup step forgets to join.
   *
   * `IgnorePlugin`, not `resolve.alias`: an alias entry for `@/lib/startup`
   * never fires, because Next resolves the `@/*` tsconfig paths with its own
   * resolve plugin, which wins before alias matching gets a look at the request.
   * `IgnorePlugin` tests the raw request in `beforeResolve`, ahead of all of
   * that. (Tried and measured, in that order -- do not "simplify" this back to
   * an alias.)
   *
   * The webpack hook is unversioned by Next's own admission (see
   * node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/webpack.md),
   * so keep this as small as it is. Turbopack ignores the hook entirely: fine
   * while `dev` and `build` are both pinned to `--webpack`, but if that pin is
   * ever dropped, re-test `next dev` itself, not just the build.
   */
  webpack(webpackConfig, { nextRuntime, webpack }) {
    if (nextRuntime === "edge") {
      webpackConfig.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@\/lib\/startup$/ }));
    }
    return webpackConfig;
  },
};

// Wraps the config to inject next-intl's request-config module (src/i18n/request.ts)
// into the server bundle so getLocale()/getTranslations() can find it.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(config);
