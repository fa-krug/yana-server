import type { NextConfig } from "next";

const config: NextConfig = {
  // The Docker image copies .next/standalone; without this the image would
  // need the full node_modules tree.
  output: "standalone",
  // better-sqlite3 is a native addon. Bundling it breaks the .node binding
  // resolution, so it must stay external and be require()d at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default config;
