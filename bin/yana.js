#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");

const pkgPath = path.join(__dirname, "..", "package.json");
let pkg = { version: "0.1.0" };
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (_) {}

function printHelp() {
  console.log(`
Yana — Self-hosted RSS aggregator (v${pkg.version})

Usage:
  yana [options]

Options:
  -p, --port <number>     Port to listen on (default: 3000 or $PORT)
  -d, --data-dir <path>   Directory for SQLite database & media (default: ~/.yana or $YANA_DATA_DIR)
  -v, --version           Show version number
  -h, --help              Show help message
`);
}

function parseArgs(args) {
  let port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  let dataDir = process.env.YANA_DATA_DIR || undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-v" || arg === "--version") {
      console.log(pkg.version);
      process.exit(0);
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "-p" || arg === "--port") {
      const val = args[++i];
      if (!val || isNaN(parseInt(val, 10))) {
        console.error("Error: --port requires a valid port number");
        process.exit(1);
      }
      port = parseInt(val, 10);
    } else if (arg.startsWith("--port=")) {
      port = parseInt(arg.split("=")[1], 10);
    } else if (arg === "-d" || arg === "--data-dir") {
      const val = args[++i];
      if (!val) {
        console.error("Error: --data-dir requires a path");
        process.exit(1);
      }
      dataDir = val;
    } else if (arg.startsWith("--data-dir=")) {
      dataDir = arg.split("=")[1];
    }
  }

  return { port, dataDir };
}

function resolveDataDir(explicit) {
  const envDir = process.env.YANA_DATA_DIR?.trim();
  const targetDir = explicit?.trim() || envDir || path.join(os.homedir(), ".yana");
  const resolvedPath = path.resolve(targetDir);
  fs.mkdirSync(resolvedPath, { recursive: true });
  return resolvedPath;
}

function checkPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(err);
      } else {
        resolve();
      }
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(port);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const { port, dataDir } = parseArgs(args);

  const resolvedDataDir = resolveDataDir(dataDir);
  const dbPath = path.join(resolvedDataDir, "yana.db");

  process.env.YANA_DATA_DIR = resolvedDataDir;
  process.env.DATABASE_PATH = dbPath;
  process.env.PORT = String(port);

  try {
    await checkPortAvailable(port);
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Try: yana --port ${port + 1}`);
      process.exit(1);
    }
  }

  const standaloneServer = path.join(__dirname, "..", ".next", "standalone", "server.js");
  if (!fs.existsSync(standaloneServer)) {
    console.error(`Error: Next.js standalone build not found at ${standaloneServer}.`);
    console.error("Please run 'npm run build' before starting Yana.");
    process.exit(1);
  }

  console.log(`=== Starting Yana (v${pkg.version}) ===`);
  console.log(`Listening on: http://localhost:${port}`);
  console.log(`Data Directory: ${resolvedDataDir}`);
  console.log(`Database File:  ${dbPath}\n`);

  require(standaloneServer);
}

main().catch((err) => {
  console.error("Fatal error starting Yana:", err);
  process.exit(1);
});
