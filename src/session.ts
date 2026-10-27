import fs from "node:fs";
import { HOME_DIR, SESSION_FILE } from "./config.js";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for session cookies. */
  expires: number;
}

export interface Session {
  cookies: StoredCookie[];
  /** Brightspace's CSRF token, needed to mint short-lived API tokens from the session. */
  xsrfToken?: string | null;
  /** Which way of calling the API worked last time. */
  authMode?: "cookie" | "bearer";
  savedAt: string;
}

export function ensureHomeDir(): void {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
}

export function loadSession(): Session | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    const parsed = JSON.parse(raw) as Session;
    return Array.isArray(parsed.cookies) ? parsed : null;
  } catch {
    return null;
  }
}

/** The session file is readable only by the current user (mode 0600). */
export function saveSession(session: Session): void {
  ensureHomeDir();
  const tmp = `${SESSION_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSION_FILE);
  try {
    fs.chmodSync(SESSION_FILE, 0o600);
  } catch {
    // Not supported on every platform (e.g. some Windows setups); ignore.
  }
}

export function clearSession(): void {
  fs.rmSync(SESSION_FILE, { force: true });
}

/** Builds a Cookie header for a request to `url` from the stored cookies. */
export function cookieHeader(session: Session, url: string): string {
  const { hostname, pathname } = new URL(url);
  const now = Date.now() / 1000;
  return session.cookies
    .filter((c) => {
      const domain = c.domain.replace(/^\./, "");
      const domainOk = hostname === domain || hostname.endsWith(`.${domain}`);
      const pathOk = pathname.startsWith(c.path || "/");
      const fresh = c.expires === -1 || c.expires === undefined || c.expires > now;
      return domainOk && pathOk && fresh;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

export function hasBrightspaceSession(session: Session): boolean {
  return session.cookies.some((c) => /^d2l(Secure)?SessionVal$/i.test(c.name));
}
