/**
 * Login via a real browser window.
 *
 * The user signs in to DTU Learn themselves (DTU SSO + MFA). We never see or
 * store their password. Afterwards we keep:
 *   - the Brightspace session cookies (~/.dtu-learn-mcp/session.json, mode 0600)
 *   - a dedicated browser profile (~/.dtu-learn-mcp/browser-profile) so that,
 *     when the Brightspace session expires, a silent re-login can often succeed
 *     using the still-valid Microsoft/DTU SSO session without asking again.
 */
import fs from "node:fs";
import type { BrowserContext, Page } from "playwright-core";
import { BASE_URL, PROFILE_DIR, log } from "./config.js";
import { ensureHomeDir, hasBrightspaceSession, saveSession, type Session } from "./session.js";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const SILENT_TIMEOUT_MS = 30_000;

function isLoggedInUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(BASE_URL).origin) return false;
    return /^\/d2l\/(home|lp\/homepage|le\/|lp\/)/i.test(url.pathname) && !/\/d2l\/login/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function launch(headless: boolean): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  ensureHomeDir();
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });

  // Prefer a browser the user already has installed, so nothing big needs downloading.
  const preferred = process.env.DTU_LEARN_BROWSER;
  const channels: (string | undefined)[] = preferred ? [preferred] : ["chrome", "msedge", undefined];
  const errors: string[] = [];
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        channel,
        viewport: null,
      });
    } catch (err) {
      errors.push(`${channel ?? "bundled chromium"}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    "Could not start a browser for DTU login. Install Google Chrome or Microsoft Edge, " +
      'or run "npx playwright install chromium", then try again.\n' +
      errors.join("\n"),
  );
}

async function capture(context: BrowserContext, page: Page): Promise<Session> {
  const cookies = (await context.cookies(BASE_URL)).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
  }));
  const xsrfToken = await page
    .evaluate(() => {
      try {
        return window.localStorage.getItem("XSRF.Token");
      } catch {
        return null;
      }
    })
    .catch(() => null);
  return { cookies, xsrfToken, savedAt: new Date().toISOString() };
}

/** Opens a visible browser window and waits for the user to finish signing in. */
export async function interactiveLogin(timeoutMs = LOGIN_TIMEOUT_MS): Promise<Session> {
  const context = await launch(false);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${BASE_URL}/d2l/home`);
    if (!isLoggedInUrl(page.url())) {
      log("A browser window opened. Sign in to DTU Learn there (including MFA). Waiting up to 5 minutes...");
      await page.waitForURL((u) => isLoggedInUrl(u.toString()), { timeout: timeoutMs });
    }
    await page.waitForLoadState("domcontentloaded");
    const session = await capture(context, page);
    if (!hasBrightspaceSession(session)) {
      throw new Error("Signed in, but no DTU Learn session cookie was found. Please try again.");
    }
    saveSession(session);
    return session;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Tries to renew the Brightspace session in a hidden browser using the saved
 * profile. Returns null if the user has to sign in again interactively.
 */
export async function silentRefresh(): Promise<Session | null> {
  if (!fs.existsSync(PROFILE_DIR)) return null;
  let context: BrowserContext | undefined;
  try {
    context = await launch(true);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${BASE_URL}/d2l/home`, { timeout: SILENT_TIMEOUT_MS });
    await page.waitForURL((u) => isLoggedInUrl(u.toString()), { timeout: SILENT_TIMEOUT_MS });
    const session = await capture(context, page);
    if (!hasBrightspaceSession(session)) return null;
    saveSession(session);
    log("Renewed the DTU Learn session silently.");
    return session;
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => undefined);
  }
}

export function clearBrowserProfile(): void {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}
