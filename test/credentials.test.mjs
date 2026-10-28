// Saved-password helpers. The Keychain round trip only runs locally on macOS, in its own Keychain item.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set before importing, so the Keychain item is a throwaway one tied to this temp dir.
process.env.DTU_LEARN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dtu-learn-creds-"));
const { deleteCredentials, loadCredentials, normalizeUsername, saveCredentials, savedUsername } = await import("../dist/credentials.js");

test("normalizeUsername adds @dtu.dk only to plain usernames", () => {
  assert.equal(normalizeUsername(" s123456 "), "s123456@dtu.dk");
  assert.equal(normalizeUsername("guest@win.dtu.dk"), "guest@win.dtu.dk");
  assert.equal(normalizeUsername("WIN\\s123456"), "WIN\\s123456");
  assert.throws(() => normalizeUsername("   "));
  assert.throws(() => normalizeUsername("s12 3456"));
});

test("saves, replaces and deletes credentials in the Keychain", { skip: process.platform !== "darwin" || Boolean(process.env.CI) }, () => {
  try {
    const tricky = 'pw with "quotes", \\backslash\\ and æøå';
    saveCredentials({ username: "WIN\\s123456", password: tricky });
    assert.deepEqual(loadCredentials(), { username: "WIN\\s123456", password: tricky });
    saveCredentials({ username: "s654321@dtu.dk", password: "second" });
    assert.equal(savedUsername(), "s654321@dtu.dk");
    assert.equal(loadCredentials()?.password, "second");
    assert.equal(deleteCredentials(), true);
    assert.equal(loadCredentials(), null);
    assert.equal(deleteCredentials(), false);
  } finally {
    deleteCredentials();
    fs.rmSync(process.env.DTU_LEARN_HOME, { recursive: true, force: true });
  }
});
