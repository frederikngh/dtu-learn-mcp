/**
 * Optional saved DTU password, for fully automatic sign-in.
 *
 * Off unless the user runs "login --save-password". The username and password
 * are kept in the macOS Keychain (never in a file) and are only ever typed into
 * DTU's own sign-in page, in the hidden browser used for silent re-login.
 */
import { execFileSync } from "node:child_process";
import { HOME_DIR } from "./config.js";

export interface Credentials {
  username: string;
  password: string;
}

// One Keychain item per DTU_LEARN_HOME, so tests and other setups never see the real one.
const SERVICE = process.env.DTU_LEARN_HOME ? `dtu-learn-mcp:${HOME_DIR}` : "dtu-learn-mcp";
const ACCOUNT = "dtu-learn";
const LABEL = "DTU Learn (dtu-learn-mcp)";
// Username and password are stored together as hex-encoded JSON: plain ASCII, so nothing
// needs quoting, and "security -w" can't turn non-ASCII passwords (æøå) into hex on its own.
const PREFIX = "v1:";
/** Never let a Keychain dialog freeze the MCP server. */
const SECURITY_TIMEOUT_MS = 10_000;
/** What "security" exits with when there is no such item. */
const NOT_FOUND = 44;

export function credentialsSupported(): boolean {
  return process.platform === "darwin";
}

/** DTU's sign-in page wants "user@domain"; plain DTU usernames get "@dtu.dk". */
export function normalizeUsername(raw: string): string {
  const username = raw.trim();
  if (!username || /\s/.test(username)) throw new Error(`"${raw}" doesn't look like a DTU username.`);
  return /[@\\]/.test(username) ? username : `${username}@dtu.dk`;
}

function security(args: string[], input?: string): string {
  return execFileSync("security", args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    timeout: SECURITY_TIMEOUT_MS,
  });
}

export function loadCredentials(): Credentials | null {
  if (!credentialsSupported()) return null;
  try {
    const stored = security(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]).trim();
    if (!stored.startsWith(PREFIX)) return null;
    const parsed = JSON.parse(Buffer.from(stored.slice(PREFIX.length), "hex").toString("utf8")) as Partial<Credentials>;
    return parsed.username && parsed.password ? { username: parsed.username, password: parsed.password } : null;
  } catch {
    return null;
  }
}

export function savedUsername(): string | null {
  return loadCredentials()?.username ?? null;
}

/** Saves or replaces the credentials in one step, so a failed save never loses the old ones. */
export function saveCredentials(creds: Credentials): void {
  if (!credentialsSupported()) throw new Error("Saving your password is only supported on macOS (Keychain) for now.");
  const hex = Buffer.from(JSON.stringify({ username: creds.username, password: creds.password }), "utf8").toString("hex");
  try {
    // Sent to "security -i" on stdin, so the password never appears in the process list.
    security(["-i"], `add-generic-password -U -s "${SERVICE}" -a "${ACCOUNT}" -l "${LABEL}" -w "${PREFIX}${hex}"\n`);
  } catch {
    // Checked below.
  }
  const saved = loadCredentials();
  if (saved?.username !== creds.username || saved.password !== creds.password) {
    throw new Error("Could not save the password in the macOS Keychain.");
  }
}

/** Returns whether there was a saved password. Throws if it exists but could not be removed. */
export function deleteCredentials(): boolean {
  if (!credentialsSupported()) return false;
  try {
    security(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === NOT_FOUND) return false;
    throw new Error("Could not remove the saved password from the macOS Keychain. Remove the item \"DTU Learn (dtu-learn-mcp)\" in Keychain Access.");
  }
}
