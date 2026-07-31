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
  serverExternalPackages: ["better-sqlite3"],
};

// Wraps the config to inject next-intl's request-config module (src/i18n/request.ts)
// into the server bundle so getLocale()/getTranslations() can find it.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(config);
