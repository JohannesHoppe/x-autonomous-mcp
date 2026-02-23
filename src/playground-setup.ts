/**
 * Vitest globalSetup: auto-start xdevplatform/playground for integration tests.
 *
 * - Checks if playground is already running on the configured port
 * - If not, starts it as a child process
 * - Waits for the health endpoint to respond
 * - Tears down the process after tests complete
 */

import { execSync, spawn, type ChildProcess } from "child_process";

const PORT = 8090;
const HEALTH_URL = `http://localhost:${PORT}/health`;
const MAX_WAIT_MS = 10000;

let child: ChildProcess | null = null;

async function isRunning(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL);
    return res.ok;
  } catch {
    return false;
  }
}

function findBinary(): string | null {
  try {
    return execSync("which playground", { encoding: "utf-8" }).trim();
  } catch {
    // Fall back to common Go install path
    const home = process.env.HOME ?? "";
    const goPath = `${home}/go/bin/playground`;
    try {
      execSync(`test -x ${goPath}`);
      return goPath;
    } catch {
      return null;
    }
  }
}

export async function setup() {
  if (await isRunning()) {
    console.log(`  Playground already running on port ${PORT}`);
    return;
  }

  const binary = findBinary();
  if (!binary) {
    console.warn(
      `\n  ⚠ playground binary not found. Install with:\n` +
      `    go install github.com/xdevplatform/playground/cmd/playground@latest\n`,
    );
    return;
  }

  console.log(`  Starting playground on port ${PORT}...`);
  child = spawn(binary, ["start", "--port", String(PORT)], {
    stdio: "ignore",
    detached: true,
  });

  // Wait for health endpoint
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    if (await isRunning()) {
      console.log(`  Playground ready`);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  console.warn("  ⚠ Playground failed to start within timeout");
  child.kill();
  child = null;
}

export async function teardown() {
  if (child) {
    child.kill();
    child = null;
    console.log("  Playground stopped");
  }
}
