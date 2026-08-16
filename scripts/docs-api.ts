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
