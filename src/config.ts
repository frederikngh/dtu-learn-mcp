import os from "node:os";
import path from "node:path";

export const VERSION = "0.1.0";

/** How users run this tool: straight from the GitHub repo (it is not on npm). */
export const RUN_COMMAND = "npx -y github:frederikngh/dtu-learn-mcp";

/** Base URL of the Brightspace instance. Overridable so the tool also works for other Brightspace schools. */
export const BASE_URL = (process.env.DTU_LEARN_URL ?? "https://learn.inside.dtu.dk").replace(/\/+$/, "");

/** Everything this tool stores lives here, on the user's own machine. */
export const HOME_DIR = process.env.DTU_LEARN_HOME ?? path.join(os.homedir(), ".dtu-learn-mcp");
export const PROFILE_DIR = path.join(HOME_DIR, "browser-profile");
export const SESSION_FILE = path.join(HOME_DIR, "session.json");
export const DOWNLOAD_DIR = process.env.DTU_LEARN_DOWNLOAD_DIR ?? path.join(HOME_DIR, "files");

/** Default number of characters of extracted file text returned per call. */
export const DEFAULT_MAX_CHARS = 40_000;

/** stdout is reserved for the MCP protocol, so all logging goes to stderr. */
export function log(...args: unknown[]): void {
  console.error("[dtu-learn]", ...args);
}
