/**
 * Load .env.local / .env the way `next dev` does, so a script run with plain
 * `node` reaches the same database the app does.
 *
 * Without this a script falls back to whatever defaults it hard-codes and
 * fails on a host the app never uses. Existing environment variables win, so
 * `PGHOST=… node scripts/x.mjs` still overrides the file.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parse(text) {
  const values = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/** Fills process.env from the project's env files; returns the files it used. */
export function loadEnv(files = [".env.local", ".env"]) {
  const loaded = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    loaded.push(file);
    for (const [key, value] of Object.entries(parse(text))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  return loaded;
}
