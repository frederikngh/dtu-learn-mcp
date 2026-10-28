#!/usr/bin/env node
/**
 * dtu-learn-mcp
 *   (no arguments, started by an AI app)  → MCP server over stdio
 *   login | logout | status | courses | ...  → command-line use
 */
import readline from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { HOME_DIR, RUN_COMMAND, VERSION } from "./config.js";
import { clearBrowserProfile, interactiveLogin, verifyPassword } from "./auth.js";
import { credentialsSupported, deleteCredentials, normalizeUsername, saveCredentials } from "./credentials.js";
import { clearSession } from "./session.js";
import { startMcpServer } from "./mcp.js";
import { findTool, type Args } from "./tools.js";

const HELP = `dtu-learn-mcp ${VERSION} — unofficial, read-only DTU Learn access for AI agents

Usage (run as "${RUN_COMMAND} <command>"):
  dtu-learn-mcp login                 Sign in to DTU Learn in a browser window (once)
  dtu-learn-mcp login --save-password Save your DTU password in the macOS Keychain so the
                                      tool signs in by itself when the session runs out
  dtu-learn-mcp forget-password       Remove the saved password (back to signing in yourself)
  dtu-learn-mcp status                Check the connection
  dtu-learn-mcp logout [--all]        Delete the saved session and any saved password
                                      (--all: also the browser profile)

  dtu-learn-mcp courses [--past]
  dtu-learn-mcp upcoming [--days 7] [--course 02450]
  dtu-learn-mcp outline <course> [--search "lecture 5"] [--module <id>]
  dtu-learn-mcp assignments <course>
  dtu-learn-mcp assignment <course> <assignmentId>
  dtu-learn-mcp topic <course> <topicId>
  dtu-learn-mcp file <course> <topicId> [--offset N] [--max N]
  dtu-learn-mcp file <course> --assignment <id> --file <fileId>
  dtu-learn-mcp file <course> --assignment <id> --submission <submissionFileId>
  dtu-learn-mcp file <course> --assignment <id> --feedback <feedbackFileId>
  dtu-learn-mcp announcements [--course 02450] [--days 14]

  dtu-learn-mcp mcp                   Run the MCP server (what AI apps start automatically)

<course> is a DTU course number (02450), part of the course name, or a Brightspace id.
Data is stored only on this computer, in ${HOME_DIR}.`;

async function runTool(name: string, args: Args): Promise<void> {
  const tool = findTool(name)!;
  console.log(await tool.run(args));
}

/** Asks a question in the terminal; with hidden, what is typed is not echoed. */
function ask(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve, reject) => {
    let answered = false;
    // Ctrl+C or Ctrl+D: stop instead of leaving the question hanging.
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (answered) return;
      process.stdout.write("\n");
      reject(new Error("Cancelled; nothing was saved."));
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
    muted = hidden;
  });
}

async function savePassword(): Promise<void> {
  if (!credentialsSupported()) throw new Error("Saving your password is only supported on macOS (Keychain) for now.");
  if (!process.stdin.isTTY) throw new Error("Run this in a terminal: it asks for your DTU username and password.");
  console.log("Your password is checked with DTU's own sign-in page and then saved in your macOS Keychain.");
  console.log("Only use this if your DTU login has no MFA step.\n");
  const username = normalizeUsername(await ask("DTU username (e.g. s123456): "));
  const password = await ask("DTU password (not shown): ", true);
  if (!password) throw new Error("No password entered; nothing was saved.");
  console.log("Checking with DTU...");
  await verifyPassword({ username, password });
  saveCredentials({ username, password });
  console.log("Saved. From now on the tool signs in by itself when the DTU Learn session runs out.");
  console.log(`To stop, run "${RUN_COMMAND} forget-password".\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Started by an AI app (stdin is a pipe) with no command → MCP server.
  if (argv.length === 0 && !process.stdin.isTTY) return startMcpServer();
  if (argv[0] === "mcp" || argv[0] === "serve") return startMcpServer();

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      days: { type: "string" },
      course: { type: "string" },
      search: { type: "string" },
      module: { type: "string" },
      assignment: { type: "string" },
      file: { type: "string" },
      submission: { type: "string" },
      feedback: { type: "string" },
      offset: { type: "string" },
      max: { type: "string" },
      past: { type: "boolean" },
      all: { type: "boolean" },
      "save-password": { type: "boolean" },
      completed: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [cmd, a, b] = positionals;

  if (values.version) return void console.log(VERSION);
  if (!cmd || values.help || cmd === "help") return void console.log(HELP);

  switch (cmd) {
    case "login": {
      if (values["save-password"]) {
        await savePassword();
        return runTool("status", {});
      }
      console.log("Opening a browser window. Sign in to DTU Learn there (including MFA)...");
      await interactiveLogin();
      return runTool("status", {});
    }
    case "forget-password":
      return void console.log(
        deleteCredentials()
          ? 'Removed the saved password. When the session runs out, sign in again with "login".'
          : "There was no saved password.",
      );
    case "logout": {
      // Also the password: otherwise the next request would just sign in again.
      const hadPassword = deleteCredentials();
      clearSession();
      if (values.all) clearBrowserProfile();
      const removed = ["session", values.all && "browser profile", hadPassword && "password"].filter(Boolean);
      return void console.log(`Removed the saved ${removed.join(", ").replace(/, ([^,]*)$/, " and $1")}.`);
    }
    case "status":
    case "doctor":
      return runTool("status", {});
    case "courses":
      return runTool("list_courses", { include_past: values.past });
    case "upcoming":
      return runTool("get_upcoming", { days: values.days, course: values.course, include_completed: values.completed });
    case "outline":
      return runTool("get_course_outline", { course: a ?? values.course, search: values.search, module_id: values.module });
    case "assignments":
      return runTool("list_assignments", { course: a ?? values.course });
    case "assignment":
      return runTool("get_assignment", { course: a, assignment_id: b ?? values.assignment });
    case "topic":
      return runTool("get_topic", { course: a, topic_id: b });
    case "file":
      return runTool("read_file", {
        course: a,
        topic_id: b,
        assignment_id: values.assignment,
        file_id: values.file,
        submission_file_id: values.submission,
        feedback_file_id: values.feedback,
        offset: values.offset,
        max_chars: values.max,
      });
    case "announcements":
      return runTool("get_announcements", { course: values.course ?? a, days: values.days });
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error((err as Error).message ?? err);
  process.exitCode = 1;
});
