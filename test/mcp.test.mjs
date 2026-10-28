// End-to-end tests: start the real MCP server (dist/cli.js) against a fake Brightspace and talk MCP to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { CURRENT_SEMESTER, OLD_SEMESTER, startFakeBrightspace } from "./fake-brightspace.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function writeSession(home, baseUrl, { cookie = "good", ...extra } = {}) {
  const host = new URL(baseUrl).hostname;
  fs.writeFileSync(
    path.join(home, "session.json"),
    JSON.stringify({
      cookies: [{ name: "d2lSessionVal", value: cookie, domain: host, path: "/", expires: -1 }],
      xsrfToken: "xsrf-1",
      savedAt: new Date().toISOString(),
      ...extra,
    }),
  );
}

function makeHome(baseUrl, session) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dtu-learn-test-"));
  writeSession(home, baseUrl, session);
  return home;
}

function startServer(baseUrl, home) {
  const child = spawn(process.execPath, [CLI], {
    env: { ...process.env, DTU_LEARN_URL: baseUrl, DTU_LEARN_HOME: home, DTU_LEARN_DOWNLOAD_DIR: path.join(home, "files") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name, args = {}) => {
    const res = await request("tools/call", { name, arguments: args });
    return { text: res.result.content[0].text, isError: Boolean(res.result.isError) };
  };
  return { child, request, call, stop: () => child.kill() };
}

for (const mode of ["cookie", "bearer"]) {
  test(`MCP server works end to end (${mode} auth)`, async (t) => {
    const fake = await startFakeBrightspace({ mode });
    const home = makeHome(fake.url);
    const srv = startServer(fake.url, home);
    t.after(async () => {
      srv.stop();
      await fake.close();
      fs.rmSync(home, { recursive: true, force: true });
    });

    const init = await srv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "dtu-learn");
    srv.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const list = await srv.request("tools/list", {});
    const names = list.result.tools.map((x) => x.name);
    for (const n of ["status", "login", "list_courses", "get_course_outline", "get_upcoming", "list_assignments", "get_assignment", "get_topic", "read_file", "get_announcements"]) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    assert.ok(list.result.tools.every((x) => x.annotations.readOnlyHint === true));

    const status = await srv.call("status");
    assert.match(status.text, /Test Student/);
    assert.match(status.text, new RegExp(`Auth mode: ${mode}`));

    const courses = await srv.call("list_courses");
    assert.match(courses.text, new RegExp(`02450 Introduction to Machine Learning, ${CURRENT_SEMESTER}`));
    assert.match(courses.text, /Linear Algebra/, "second page of enrollments is followed");
    assert.doesNotMatch(courses.text, new RegExp(OLD_SEMESTER), "past semesters hidden by default, despite DTU's 5-year end dates");
    const allCourses = await srv.call("list_courses", { include_past: true });
    assert.match(allCourses.text, new RegExp(OLD_SEMESTER));

    const outline = await srv.call("get_course_outline", { course: "02450" });
    assert.match(outline.text, /\[id=111111\]/, "picks the current run of the course");
    assert.match(outline.text, /Welcome to 02450!/);
    assert.match(outline.text, /Lecture 5 slides\s+\(file \.pptx; topicId=501; unread\)/);
    assert.match(outline.text, /external tool \(LTI\)/);
    assert.match(outline.text, /video123\.mp4\s+\(video; topicId=503\)/, "media library videos are not called files");

    const search = await srv.call("get_course_outline", { course: "02450", search: "lecture 15" });
    assert.match(search.text, /Week 15- Recap[^\n]*\n\s+▸ Slides[^\n]*\n\s+- 02450_Lecture_15 /, "matches underscores and keeps the week");
    assert.doesNotMatch(search.text, /Lecture 5 slides/);
    const searchOne = await srv.call("get_course_outline", { course: "02450", search: "Lecture 1" });
    assert.match(searchOne.text, /nothing matching "Lecture 1"/, '"Lecture 1" does not match "Lecture 15"');
    const searchWeek = await srv.call("get_course_outline", { course: "02450", search: "week 5" });
    assert.match(searchWeek.text, /Lecture 5 slides[\s\S]*Panopto recording/, "a matching module is shown whole");

    const file = await srv.call("read_file", { course: "02450", topic_id: 501 });
    assert.match(file.text, /PowerPoint, 2 slides/);
    assert.match(file.text, /--- Slide 1 ---\nLecture 5: Regularization\nBias & variance/);
    assert.match(file.text, /\[Speaker notes\]\nRemember to mention ridge/);
    assert.ok(fs.existsSync(path.join(home, "files", `02450 Introduction to Machine Learning, ${CURRENT_SEMESTER}`, "lec5.pptx")));

    const attachment = await srv.call("read_file", { course: "02450", assignment_id: 7, file_id: 70 });
    assert.match(attachment.text, /spec\.pptx/);

    const upcoming = await srv.call("get_upcoming", { days: 7 });
    assert.match(upcoming.text, /Lecture 5 slides \(file due; topicId=501\)/);
    assert.match(upcoming.text, /Project 1 - Due \(assignment; assignmentId=7\)/);
    assert.match(upcoming.text, /\| Lecture \(calendar event; LYN\.303A\.AUD41\.R:001\)/, "timetable events with rooms");
    assert.doesNotMatch(upcoming.text, /not in DTU Learn/, "no claim that the timetable is missing");
    assert.match(upcoming.text, new RegExp(`${OLD_SEMESTER} \\| Lab 3 - Due`), "deadlines in older courses still show");

    const assignments = await srv.call("list_assignments", { course: "machine learning" });
    assert.match(assignments.text, /Project 1/);
    assert.doesNotMatch(assignments.text, /Hidden draft/);

    const assignment = await srv.call("get_assignment", { course: "02450", assignment_id: 7 });
    assert.match(assignment.text, /Write a report\.\n\n?- Max 10 pages/);
    assert.match(assignment.text, /spec\.pptx\s+\[fileId=70/);
    assert.match(assignment.text, /You have not submitted anything yet/);

    const graded = await srv.call("get_assignment", { course: "02450", assignment_id: 11 });
    assert.match(graded.text, /Feedback: See the comments in the file\./);
    assert.match(graded.text, /grp9_assignment_0\.ipynb\s+\[feedbackFileId=90; 4 KB\]/);
    assert.match(graded.text, /: assignment_0\.ipynb\s+\[submissionFileId=80; 3 KB\]/);
    const submitted = await srv.call("read_file", { course: "02450", assignment_id: 11, submission_file_id: 80 });
    assert.match(submitted.text, /Jupyter notebook, 1 cells?/);
    assert.match(submitted.text, /x = conv\(img, k\)/);
    assert.ok(fs.existsSync(path.join(home, "files", `02450 Introduction to Machine Learning, ${CURRENT_SEMESTER}`, "submission_assignment_0.ipynb")));
    const noSuchSubmission = await srv.call("read_file", { course: "02450", assignment_id: 11, submission_file_id: 999 });
    assert.equal(noSuchSubmission.isError, true);
    assert.match(noSuchSubmission.text, /No submitted file 999/);
    const feedbackFile = await srv.call("read_file", { course: "02450", assignment_id: 11, feedback_file_id: 90 });
    assert.match(feedbackFile.text, /Jupyter notebook, 2 cells/);
    assert.match(feedbackFile.text, /TA: explain why you chose this kernel/);
    assert.ok(fs.existsSync(path.join(home, "files", `02450 Introduction to Machine Learning, ${CURRENT_SEMESTER}`, "feedback_grp9_assignment_0.ipynb")));
    const noSuchFeedback = await srv.call("read_file", { course: "02450", assignment_id: 11, feedback_file_id: 999 });
    assert.equal(noSuchFeedback.isError, true);
    assert.match(noSuchFeedback.text, /No feedback file 999/);

    const topic = await srv.call("get_topic", { course: "02450", topic_id: 502 });
    assert.match(topic.text, /URL: https:\/\/panopto\.example\/x/);

    const video = await srv.call("get_topic", { course: "02450", topic_id: 503 });
    assert.match(video.text, /\[topicId=503; video\]/);
    assert.doesNotMatch(video.text, /URL: d2l:/, "no internal media reference shown as a URL");
    assert.match(video.text, /Open in DTU Learn: /);

    const news = await srv.call("get_announcements", {});
    assert.match(news.text, /Room change[\s\S]*Lecture moves to B116\./);
    assert.match(news.text, /Lab 3 extended/, "announcements from older courses still show");

    const missing = await srv.call("get_course_outline", { course: "99999" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /No course matching "99999"/);

    assert.ok(fake.calls.every((c) => c.startsWith("GET ") || c === "POST /d2l/lp/auth/oauth2/token"), "only GETs hit the API");
  });
}

test("an expired session gives a clear sign-in message, not a raw 403", async (t) => {
  const fake = await startFakeBrightspace();
  const home = makeHome(fake.url, { cookie: "expired", authMode: "cookie" });
  const srv = startServer(fake.url, home);
  t.after(async () => {
    srv.stop();
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await srv.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  const courses = await srv.call("list_courses");
  assert.equal(courses.isError, true);
  assert.match(courses.text, /session has expired[\s\S]*dtu-learn-mcp login/);
  assert.doesNotMatch(courses.text, /403/);
});

test("picks up a session saved by a later login (e.g. the CLI login command)", async (t) => {
  const fake = await startFakeBrightspace();
  const home = makeHome(fake.url, { cookie: "expired", authMode: "cookie", savedAt: "2026-01-01T00:00:00.000Z" });
  const srv = startServer(fake.url, home);
  t.after(async () => {
    srv.stop();
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  // The server has loaded the expired session; now a login elsewhere saves a fresh one.
  await srv.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  writeSession(home, fake.url);
  const status = await srv.call("status");
  assert.match(status.text, /Test Student/);
  assert.match(status.text, /Auth mode: cookie/);
});

test("reports a clear sign-in message when there is no session", async (t) => {
  const fake = await startFakeBrightspace();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dtu-learn-test-"));
  const srv = startServer(fake.url, home);
  t.after(async () => {
    srv.stop();
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await srv.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  const status = await srv.call("status");
  assert.match(status.text, /Not signed in/);
  const courses = await srv.call("list_courses");
  assert.equal(courses.isError, true);
  assert.match(courses.text, /dtu-learn-mcp login/);
});
