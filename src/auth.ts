/**
 * Login via a real browser window.
 *
 * The user signs in to DTU Learn themselves (DTU SSO + MFA). We never see or
 * store their password. Afterwards we keep:
 *   - the Brightspace session cookies (~/.dtu-learn-mcp/session.json, mode 0600)
 *   - a dedicated browser profile (~/.dtu-learn-mcp/browser-profile) so that,
 *     when the Brightspace session expires, a silent re-login can often succeed
 *     using the still-valid Microsoft/DTU SSO session without asking again.
 *
 * Opt-in exception: after "login --save-password" the password is kept in the
 * macOS Keychain (see credentials.ts) and the silent re-login types it into
 * DTU's sign-in page itself, so it keeps working after the SSO session ends.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { BASE_URL, PROFILE_DIR, log } from "./config.js";
import { deleteCredentials, loadCredentials, type Credentials } from "./credentials.js";
import { ensureHomeDir, hasBrightspaceSession, saveSession, type Session } from "./session.js";

/** DTU's sign-in page did not let the saved username and password in (wrong, changed, locked, MFA, ...). */
export class PasswordRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordRejectedError";
  }
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const SILENT_TIMEOUT_MS = 30_000;
/** The only page a saved password is ever typed into: DTU's own sign-in server. */
const DTU_SIGN_IN_HOST = "sts.ait.dtu.dk";
/** At most one automatic password sign-in per minute, whatever happens. */
const PASSWORD_RETRY_MS = 60_000;

let lastPasswordAttempt = 0;

function isLoggedInUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(BASE_URL).origin) return false;
    return /^\/d2l\/(home|lp\/homepage|le\/|lp\/)/i.test(url.pathname) && !/\/d2l\/login/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function launch(headless: boolean, profileDir = PROFILE_DIR): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  ensureHomeDir();
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  // Prefer a browser the user already has installed, so nothing big needs downloading.
  const preferred = process.env.DTU_LEARN_BROWSER;
  const channels: (string | undefined)[] = preferred ? [preferred] : ["chrome", "msedge", undefined];
  const errors: string[] = [];
  for (const channel of channels) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
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

/** Saves the Brightspace session from a signed-in page. */
async function captureSession(context: BrowserContext, page: Page): Promise<Session> {
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
  const session: Session = { cookies, xsrfToken, savedAt: new Date().toISOString() };
  if (!hasBrightspaceSession(session)) {
    throw new Error("Signed in, but no DTU Learn session cookie was found. Please try again.");
  }
  saveSession(session);
  return session;
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
    return await captureSession(context, page);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Waits until DTU Learn is open. With credentials, types them into DTU's
 * sign-in page if that appears instead. Returns whether the password was typed.
 *
 * Once the password has been submitted, anything other than arriving in DTU
 * Learn (an error, a lockout or password-expired page, an MFA prompt, a
 * timeout) counts as rejected, so the caller never submits it again blindly.
 */
async function signIn(page: Page, creds: Credentials | null): Promise<boolean> {
  const loggedIn = () => page.waitForURL((u) => isLoggedInUrl(u.toString()), { timeout: SILENT_TIMEOUT_MS });
  if (!creds) {
    await loggedIn();
    return false;
  }

  const passwordInput = page.locator("#passwordInput");
  // Either the SSO session is still valid and we land in DTU Learn, or the sign-in form appears.
  await Promise.race([loggedIn(), passwordInput.waitFor({ state: "visible", timeout: SILENT_TIMEOUT_MS })]);
  if (isLoggedInUrl(page.url())) return false;
  if (new URL(page.url()).hostname !== DTU_SIGN_IN_HOST) {
    throw new Error(`Not typing the saved DTU password into ${new URL(page.url()).hostname}: it is not DTU's sign-in page.`);
  }

  lastPasswordAttempt = Date.now();
  await page.locator("#userNameInput").fill(creds.username);
  await passwordInput.fill(creds.password);
  await page.locator("#submitButton").click();
  const errorText = page.locator("#errorText").filter({ hasText: /\S/ });
  const outcome = await Promise.race([
    loggedIn().then(() => "in" as const),
    errorText.waitFor({ state: "attached", timeout: SILENT_TIMEOUT_MS }).then(() => "error" as const),
  ]).catch(() => "timeout" as const);
  if (outcome === "in") return true;

  const message = outcome === "error" ? (await errorText.textContent().catch(() => null))?.trim() : null;
  const where = new URL(page.url());
  throw new PasswordRejectedError(message || `DTU did not finish the sign-in (it stopped at ${where.hostname}${where.pathname})`);
}

/** Signs in in a hidden browser, with the password if given. */
async function headlessLogin(creds: Credentials | null, profileDir = PROFILE_DIR): Promise<{ session: Session; typedPassword: boolean }> {
  const context = await launch(true, profileDir);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${BASE_URL}/d2l/home`, { timeout: SILENT_TIMEOUT_MS });
    const typedPassword = await signIn(page, creds);
    return { session: await captureSession(context, page), typedPassword };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Checks a username and password on DTU's sign-in page, in a fresh browser
 * profile so an existing sign-in can't make a wrong password look right.
 * Saves the resulting session; does not save the password.
 */
export async function verifyPassword(creds: Credentials): Promise<Session> {
  const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), "dtu-learn-check-"));
  try {
    const { session, typedPassword } = await headlessLogin(creds, tempProfile);
    if (!typedPassword) throw new Error("DTU did not show its sign-in page, so the password could not be checked.");
    return session;
  } finally {
    fs.rmSync(tempProfile, { recursive: true, force: true });
  }
}

/**
 * Tries to renew the Brightspace session in a hidden browser using the saved
 * profile, and the saved password if there is one. Returns null if the user
 * has to sign in again interactively.
 *
 * A rejected password is deleted at once (and PasswordRejectedError rethrown):
 * retrying it on every request could get the DTU account locked.
 */
export async function silentRefresh(): Promise<Session | null> {
  const creds = Date.now() - lastPasswordAttempt >= PASSWORD_RETRY_MS ? loadCredentials() : null;
  if (!creds && !fs.existsSync(PROFILE_DIR)) return null;
  try {
    const { session, typedPassword } = await headlessLogin(creds);
    log(typedPassword ? "Signed in to DTU Learn again with the saved password." : "Renewed the DTU Learn session silently.");
    return session;
  } catch (err) {
    if (!(err instanceof PasswordRejectedError)) return null;
    deleteCredentials();
    throw err;
  }
}

export function clearBrowserProfile(): void {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}
