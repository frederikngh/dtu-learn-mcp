/**
 * Minimal, read-only Brightspace (Valence) API client.
 *
 * Only GET requests are ever sent to the API. The single POST this file makes
 * goes to Brightspace's own token endpoint to turn the browser session into a
 * short-lived API token (the same thing the Brightspace web UI does itself).
 */
import { BASE_URL, RUN_COMMAND, log } from "./config.js";
import { PasswordRejectedError, silentRefresh } from "./auth.js";
import { cookieHeader, loadSession, saveSession, type Session } from "./session.js";

export class AuthRequiredError extends Error {
  constructor(message = `Not signed in to DTU Learn. Run "${RUN_COMMAND} login" in a terminal (or use the login tool).`) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    detail: string,
  ) {
    super(`DTU Learn API ${status} for ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "ApiError";
  }
}

export interface Versions {
  lp: string;
  le: string;
}

interface Bearer {
  token: string;
  expiresAt: number; // ms
}

const MAX_RETRIES = 3;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export class DtuLearnClient {
  private session: Session | null = loadSession();
  private bearer: Bearer | null = null;
  private versionsCache: Versions | null = null;
  private refreshing: Promise<boolean> | null = null;

  get authMode(): string {
    return this.session?.authMode ?? "unknown";
  }

  hasSession(): boolean {
    return this.session !== null;
  }

  reloadSession(): void {
    this.session = loadSession();
    this.bearer = null;
  }

  /** Renews the session without a window, sharing a renewal that is already running. */
  refresh(): Promise<boolean> {
    return this.refreshOnce();
  }

  // ---- public helpers -----------------------------------------------------

  async versions(): Promise<Versions> {
    if (this.versionsCache) return this.versionsCache;
    const list = await this.getJson<{ ProductCode: string; LatestVersion: string; SupportedVersions?: string[] }[]>(
      "/d2l/api/versions/",
    );
    const pick = (code: string, envVar: string) => {
      const fromEnv = process.env[envVar];
      if (fromEnv) return fromEnv;
      const entry = list.find((p) => p.ProductCode.toLowerCase() === code);
      if (!entry) throw new Error(`DTU Learn did not report a version for the "${code}" API.`);
      const all = [entry.LatestVersion, ...(entry.SupportedVersions ?? [])].filter(Boolean);
      return all.sort(compareVersions).at(-1)!;
    };
    this.versionsCache = { lp: pick("lp", "DTU_LEARN_LP_VERSION"), le: pick("le", "DTU_LEARN_LE_VERSION") };
    return this.versionsCache;
  }

  async lp(path: string): Promise<string> {
    return `/d2l/api/lp/${(await this.versions()).lp}${path}`;
  }

  async le(path: string): Promise<string> {
    return `/d2l/api/le/${(await this.versions()).le}${path}`;
  }

  async getJson<T>(path: string): Promise<T> {
    const res = await this.get(path);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(res.status, path, "response was not JSON (the session may have expired)");
    }
  }

  async getBinary(path: string): Promise<{ data: Buffer; contentType: string; filename: string | null }> {
    const res = await this.get(path);
    const data = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    return { data, contentType, filename: filenameFromDisposition(res.headers.get("content-disposition")) };
  }

  /** Where a redirecting page (e.g. a quicklink) points, without following it. Null if it does not redirect. */
  async getRedirect(path: string): Promise<string | null> {
    const res = await this.get(path, true);
    await res.body?.cancel();
    return res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  }

  /** Follows Brightspace "ObjectListPage" pagination ({ Objects, Next }). */
  async getObjectListPages<T>(path: string, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    for (let i = 0; next && i < maxPages; i++) {
      const page: { Objects?: T[]; Next?: string | null } = await this.getJson(next);
      out.push(...(page.Objects ?? []));
      next = page.Next ? toPath(page.Next) : null;
    }
    return out;
  }

  /** Follows Brightspace "PagedResultSet" pagination ({ PagingInfo, Items }). */
  async getPagedResultSet<T>(path: string, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let bookmark: string | null = null;
    for (let i = 0; i < maxPages; i++) {
      const sep = path.includes("?") ? "&" : "?";
      const url: string = bookmark ? `${path}${sep}bookmark=${encodeURIComponent(bookmark)}` : path;
      const page: { Items?: T[]; PagingInfo?: { Bookmark?: string; HasMoreItems?: boolean } } = await this.getJson(url);
      out.push(...(page.Items ?? []));
      if (!page.PagingInfo?.HasMoreItems || !page.PagingInfo.Bookmark) break;
      bookmark = page.PagingInfo.Bookmark;
    }
    return out;
  }

  async whoami(): Promise<{ Identifier: string; FirstName: string; LastName: string; UniqueName: string }> {
    return this.getJson(await this.lp("/users/whoami"));
  }

  // ---- core request logic ------------------------------------------------

  /** Read-only by construction: this is the only way the client talks to the API. */
  private async get(path: string, allowRedirect = false): Promise<Response> {
    if (!this.session) {
      if (!(await this.refreshOnce())) throw new AuthRequiredError();
    }

    let res = await this.send(path);
    // Until we know which auth style DTU accepts, a 403 may mean "cookie auth not accepted".
    const unsure = !this.session?.authMode && res.status === 403;
    if (!(await isAuthFailure(res)) && !unsure) {
      // /versions/ is public, and web pages (e.g. course files) always take cookies, so neither says how the API works.
      const api = path.startsWith("/d2l/api/") && !path.startsWith("/d2l/api/versions");
      if (res.ok && !this.session?.authMode && api) this.rememberAuthMode("cookie");
      return this.check(res, path, allowRedirect);
    }

    // 1) Cookie auth rejected? Try a short-lived bearer token minted from the session.
    if (this.session?.authMode !== "bearer" && (await this.mintBearer())) {
      res = await this.send(path, true);
      if (!(await isAuthFailure(res))) {
        this.rememberAuthMode("bearer");
        return this.check(res, path, allowRedirect);
      }
    }

    // 2) Session expired? Try a silent re-login, then retry once.
    if (await this.refreshOnce()) {
      res = await this.send(path);
      if ((await isAuthFailure(res)) && (await this.mintBearer())) res = await this.send(path, true);
      if (!(await isAuthFailure(res))) return this.check(res, path, allowRedirect);
    }
    throw new AuthRequiredError(`Your DTU Learn session has expired. Run "${RUN_COMMAND} login" (or use the login tool) to sign in again.`);
  }

  private async send(path: string, forceBearer = false): Promise<Response> {
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json, */*",
      Cookie: cookieHeader(this.session!, url),
      "User-Agent": "dtu-learn-mcp (unofficial, read-only)",
    };
    const useBearer = forceBearer || this.session?.authMode === "bearer";
    if (useBearer) {
      if (!this.bearer || this.bearer.expiresAt - Date.now() < 60_000) await this.mintBearer();
      if (this.bearer) headers.Authorization = `Bearer ${this.bearer.token}`;
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method: "GET", headers, redirect: "manual" });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
        continue;
      }
      return res;
    }
  }

  private async check(res: Response, path: string, allowRedirect = false): Promise<Response> {
    if (res.ok || (allowRedirect && res.status >= 300 && res.status < 400)) return res;
    let detail = "";
    try {
      const body = await res.text();
      detail = body.slice(0, 300).replace(/\s+/g, " ");
    } catch {
      // ignore
    }
    throw new ApiError(res.status, path, detail);
  }

  private async mintBearer(): Promise<boolean> {
    if (!this.session?.xsrfToken) return false;
    try {
      const url = `${BASE_URL}/d2l/lp/auth/oauth2/token`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Cookie: cookieHeader(this.session, url),
          "X-Csrf-Token": this.session.xsrfToken,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "scope=*:*:*",
        redirect: "manual",
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { access_token?: string; expires_at?: number };
      if (!json.access_token) return false;
      const expiresAt = json.expires_at ? json.expires_at * 1000 : Date.now() + 30 * 60_000;
      this.bearer = { token: json.access_token, expiresAt };
      return true;
    } catch {
      return false;
    }
  }

  /** Ensures only one silent refresh runs at a time. */
  private async refreshOnce(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        // Another process (e.g. "dtu-learn-mcp login") may have saved a fresh session.
        const onDisk = loadSession();
        if (onDisk && onDisk.savedAt !== this.session?.savedAt) {
          this.session = onDisk;
          this.bearer = null;
          return true;
        }
        let refreshed: Session | null;
        try {
          refreshed = await silentRefresh();
        } catch (err) {
          if (!(err instanceof PasswordRejectedError)) throw err;
          throw new AuthRequiredError(
            `DTU rejected the saved password ("${err.message}"), so it was removed from the Keychain to avoid locking your account. ` +
              `Run "${RUN_COMMAND} login --save-password" in a terminal to save it again.`,
          );
        }
        if (refreshed) {
          this.session = { ...refreshed, authMode: this.session?.authMode };
          this.bearer = null;
          return true;
        }
        return false;
      })().finally(() => {
        setTimeout(() => (this.refreshing = null), 5_000);
      });
    }
    return this.refreshing;
  }

  private rememberAuthMode(mode: "cookie" | "bearer"): void {
    if (!this.session || this.session.authMode === mode) return;
    this.session.authMode = mode;
    try {
      saveSession(this.session);
    } catch (err) {
      log("Could not save auth mode:", (err as Error).message);
    }
  }
}

async function isAuthFailure(res: Response): Promise<boolean> {
  if (res.status === 401) return true;
  // DTU Learn answers API calls with an expired session with this plain-text 403 (not 401 or a redirect).
  // Other 403s ({"Errors":[{"Message":"Not Authorized"}]}) are real permission errors.
  if (res.status === 403) return /^\s*Authentication required/i.test(await res.clone().text());
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "";
    return /login|sso|saml|oauth|microsoftonline/i.test(location) || location === "";
  }
  return false;
}

function toPath(next: string): string {
  if (!next.startsWith("http")) return next;
  const u = new URL(next);
  return `${u.pathname}${u.search}`;
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}
