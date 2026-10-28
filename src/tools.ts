/** Tool definitions shared by the MCP server and the CLI. Every tool is read-only. */
import { BASE_URL, DEFAULT_MAX_CHARS, DOWNLOAD_DIR, RUN_COMMAND } from "./config.js";
import { ACTIVITY_TYPES, courseLabel, DtuLearn, type FileResult, type TocModule } from "./api.js";
import { interactiveLogin } from "./auth.js";
import { AuthRequiredError } from "./client.js";
import { savedUsername } from "./credentials.js";
import { fmtDate, richText, truncate } from "./text.js";

export type Args = Record<string, unknown>;

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  run(args: Args): Promise<string>;
}

const learn = new DtuLearn();

// ---- argument helpers -------------------------------------------------------

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
}

function requireStr(args: Args, key: string): string {
  const v = str(args, key);
  if (!v) throw new Error(`Missing required argument "${key}".`);
  return v;
}

function int(args: Args, key: string, fallback?: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Argument "${key}" must be a number.`);
  return Math.trunc(n);
}

function bool(args: Args, key: string): boolean {
  const v = args[key];
  return v === true || v === "true" || v === 1 || v === "1";
}

const COURSE_ARG = {
  type: "string",
  description: 'Course: a DTU course number (e.g. "02450"), part of the course name, or the Brightspace org unit id from list_courses.',
};

// ---- formatting -------------------------------------------------------------

function formatModule(m: TocModule, depth: number, lines: string[], includeHidden: boolean): void {
  if (m.IsHidden && !includeHidden) return;
  const pad = "  ".repeat(depth);
  const dates = [m.StartDateTime && `from ${fmtDate(m.StartDateTime)}`, m.EndDateTime && `until ${fmtDate(m.EndDateTime)}`]
    .filter(Boolean)
    .join(", ");
  lines.push(`${pad}▸ ${m.Title}  [moduleId=${m.ModuleId}${dates ? `; ${dates}` : ""}]`);
  const children: ({ t: "m"; m: TocModule } | { t: "t"; x: NonNullable<TocModule["Topics"]>[number] })[] = [
    ...(m.Modules ?? []).map((x) => ({ t: "m" as const, m: x })),
    ...(m.Topics ?? []).map((x) => ({ t: "t" as const, x })),
  ];
  children.sort((a, b) => (a.t === "m" ? a.m.SortOrder : a.x.SortOrder)! - (b.t === "m" ? b.m.SortOrder : b.x.SortOrder)!);
  for (const c of children) {
    if (c.t === "m") {
      formatModule(c.m, depth + 1, lines, includeHidden);
      continue;
    }
    const t = c.x;
    if (t.IsHidden && !includeHidden) continue;
    const kind = topicKind(t.ActivityType, t.Url);
    const flags = [t.Unread && "unread", t.IsBroken && "broken link", t.EndDateTime && `until ${fmtDate(t.EndDateTime)}`]
      .filter(Boolean)
      .join(", ");
    lines.push(`${pad}  - ${t.Title}  (${kind}; topicId=${t.TopicId}${flags ? `; ${flags}` : ""})`);
  }
}

/** Media library items have an internal reference instead of a URL, and no downloadable file. */
function isMediaRef(url: string | null | undefined): boolean {
  return Boolean(url?.startsWith("d2l:brightspace:content:"));
}

function topicKind(activityType: number | undefined, url: string | undefined): string {
  if (isMediaRef(url)) return url!.includes(":video:") ? "video" : "media";
  const base = ACTIVITY_TYPES[activityType ?? -1] ?? "item";
  if (base === "file" && url) {
    const ext = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(url)?.[1];
    return ext ? `file .${ext.toLowerCase()}` : "file";
  }
  return base;
}

/**
 * Title matcher for outline search. DTU titles are often file names ("02462_Lecture_5"), so case, _ and - are
 * ignored, and a number must match whole ("Lecture 1" does not match "Lecture 15").
 */
function titleMatcher(search: string): (title: string) => boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-–.]+/g, " ").trim();
  const needle = norm(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${/^\d/.test(needle) ? "(?<!\\d)" : ""}${needle}${/\d$/.test(needle) ? "(?!\\d)" : ""}`);
  return (title) => re.test(norm(title));
}

/** Keeps matching modules whole, and the path down to each matching topic or submodule. */
function filterModules(modules: TocModule[], matches: (title: string) => boolean): TocModule[] {
  const out: TocModule[] = [];
  for (const m of modules) {
    if (matches(m.Title)) {
      out.push(m);
      continue;
    }
    const Modules = filterModules(m.Modules ?? [], matches);
    const Topics = (m.Topics ?? []).filter((t) => matches(t.Title));
    if (Modules.length || Topics.length) out.push({ ...m, Modules, Topics });
  }
  return out;
}

function findModule(modules: TocModule[], id: number): TocModule | null {
  for (const m of modules) {
    if (m.ModuleId === id) return m;
    const inner = findModule(m.Modules ?? [], id);
    if (inner) return inner;
  }
  return null;
}

function formatFile(result: FileResult, offset: number, maxChars: number): string {
  const head = [
    `File: ${result.filename} (${(result.bytes / 1024).toFixed(0)} KB)`,
    result.savedTo ? `Saved locally to: ${result.savedTo}` : "",
  ].filter(Boolean);
  if (!result.extracted) {
    head.push("No text could be extracted from this file type. Open the saved file directly instead.");
    return head.join("\n");
  }
  const { text, kind } = result.extracted;
  const slice = text.slice(offset, offset + maxChars);
  head.push(`Content: ${kind}; ${text.length} characters total.`);
  if (offset > 0 || offset + maxChars < text.length) {
    head.push(
      `Showing characters ${offset}–${offset + slice.length}.` +
        (offset + maxChars < text.length ? ` Call again with offset=${offset + maxChars} for more.` : ""),
    );
  }
  return `${head.join("\n")}\n\n${slice}`;
}

// ---- tools ------------------------------------------------------------------

export const tools: Tool[] = [
  {
    name: "status",
    title: "Check DTU Learn connection",
    description: "Checks whether you are signed in to DTU Learn and shows who you are signed in as. Use this first if other tools report authentication problems.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      const username = savedUsername();
      if (!learn.client.hasSession() && !username) {
        return `Not signed in. Run "${RUN_COMMAND} login" in a terminal, or call the login tool.`;
      }
      try {
        const me = await learn.client.whoami();
        const v = await learn.client.versions();
        const courses = await learn.listCourses();
        return [
          `Signed in to ${BASE_URL} as ${me.FirstName} ${me.LastName} (${me.UniqueName}).`,
          `API versions: lp ${v.lp}, le ${v.le}. Auth mode: ${learn.client.authMode}.`,
          `Automatic sign-in: ${username ? `on (password for ${username} saved in the macOS Keychain)` : "off"}.`,
          `Current courses: ${courses.length}. Downloaded files go to ${DOWNLOAD_DIR}.`,
        ].join("\n");
      } catch (err) {
        if (err instanceof AuthRequiredError) return err.message;
        throw err;
      }
    },
  },
  {
    name: "login",
    title: "Sign in to DTU Learn",
    description:
      "Signs in to DTU Learn. Only call this when other tools say the user is not signed in. If the user turned on automatic sign-in (saved password) this happens without a window; otherwise it opens a browser window on the user's computer where they sign in themselves (DTU login + MFA), so tell the user to look for it. Waits up to 5 minutes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      // With a saved password, try signing in without a window first.
      let note = "";
      if (savedUsername()) {
        try {
          if (await learn.client.refresh()) {
            const me = await learn.client.whoami();
            return `Signed in as ${me.FirstName} ${me.LastName} with the saved password; no browser window was needed.`;
          }
        } catch (err) {
          if (!(err instanceof AuthRequiredError)) throw err;
          note = `${err.message}\n`;
        }
      }
      await interactiveLogin();
      learn.client.reloadSession();
      const me = await learn.client.whoami();
      return `${note}Signed in as ${me.FirstName} ${me.LastName}. The session is stored only on this computer.`;
    },
  },
  {
    name: "list_courses",
    title: "List my courses",
    description: "Lists the user's DTU Learn courses (current semester by default) with their ids. Use the course number or id with the other tools.",
    inputSchema: {
      type: "object",
      properties: { include_past: { type: "boolean", description: "Also list courses from earlier semesters." } },
      additionalProperties: false,
    },
    async run(args) {
      const courses = await learn.listCourses(bool(args, "include_past"));
      if (courses.length === 0) return "No courses found.";
      return courses
        .map((c) => {
          const when = c.startDate ? ` (${c.startDate.slice(0, 10)} → ${c.endDate?.slice(0, 10) ?? "?"})` : "";
          return `- ${courseLabel(c)}  [id=${c.id}${c.code ? `; code=${c.code}` : ""}]${when}${c.isActive ? "" : " (inactive)"}`;
        })
        .join("\n");
    },
  },
  {
    name: "get_course_outline",
    title: "Course content outline",
    description:
      "Shows a course's content tree (modules, lecture folders, slides, files, links, quizzes) with topicIds. Use `search` to filter by title (e.g. 'Lecture 5', 'week 6', 'exercise'), or module_id for one folder. Then use read_file with a topicId to read a file.",
    inputSchema: {
      type: "object",
      properties: {
        course: COURSE_ARG,
        search: { type: "string", description: "Only modules/topics whose title contains this text (ignores case, _ and -)." },
        module_id: { type: "number", description: "Only show this module and what is inside it." },
        include_hidden: { type: "boolean", description: "Include items marked hidden." },
      },
      required: ["course"],
      additionalProperties: false,
    },
    async run(args) {
      const course = await learn.resolveCourse(requireStr(args, "course"));
      const search = str(args, "search");
      const moduleId = int(args, "module_id");
      let modules = await learn.getToc(course.id);
      if (search) modules = filterModules(modules, titleMatcher(search));
      if (moduleId !== undefined) {
        const m = findModule(modules, moduleId);
        if (!m) return `Module ${moduleId} not found in ${courseLabel(course)}.`;
        modules = [m];
      }
      const lines = [`Course: ${courseLabel(course)} [id=${course.id}]`];
      if (!search && moduleId === undefined) {
        const overview = await learn.getOverview(course.id);
        if (overview?.text) lines.push("", "Course overview:", truncate(overview.text, 1500));
      }
      lines.push("", "Content:");
      const before = lines.length;
      for (const m of modules) formatModule(m, 0, lines, bool(args, "include_hidden"));
      if (lines.length === before) lines.push(search ? `(nothing matching "${search}")` : "(no content)");
      return lines.join("\n");
    },
  },
  {
    name: "get_upcoming",
    title: "What's coming up",
    description:
      "Lists deadlines and dated items in the next N days across all courses (or one course): assignment due dates, quizzes, content with dates, and calendar events, which at DTU include timetable lectures and group work with rooms. Good for 'what do I need to do this week?'.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead to look (default 7, max 120)." },
        course: { ...COURSE_ARG, description: `${COURSE_ARG.description} Omit for all courses.` },
        include_completed: { type: "boolean", description: "Also include items already completed." },
      },
      additionalProperties: false,
    },
    async run(args) {
      const days = Math.min(Math.max(int(args, "days", 7)!, 1), 120);
      const { items, warnings } = await learn.getUpcoming(days, str(args, "course"), bool(args, "include_completed"));
      const lines = items.map(
        (i) =>
          `- ${fmtDate(i.date)} | ${i.courseLabel} | ${i.title} (${i.kind}${i.ref ? `; ${i.ref}` : ""}${i.location ? `; ${i.location}` : ""})`,
      );
      if (lines.length === 0) lines.push(`Nothing dated in the next ${days} days.`);
      if (warnings.length) lines.push("", ...warnings.map((w) => `Note: ${w}`));
      return lines.join("\n");
    },
  },
  {
    name: "list_assignments",
    title: "List assignments",
    description: "Lists a course's assignments (hand-in folders) with due dates and attachment counts, sorted by due date.",
    inputSchema: { type: "object", properties: { course: COURSE_ARG }, required: ["course"], additionalProperties: false },
    async run(args) {
      const course = await learn.resolveCourse(requireStr(args, "course"));
      const folders = await learn.listAssignments(course.id);
      if (folders.length === 0) return `No assignments in ${courseLabel(course)}.`;
      return [
        `Assignments in ${courseLabel(course)}:`,
        ...folders.map((f) => {
          const due = f.DueDate ? `due ${fmtDate(f.DueDate)}` : "no due date";
          const files = f.Attachments?.length ? `; ${f.Attachments.length} attachment(s)` : "";
          const group = f.GroupTypeId ? "; group hand-in" : "";
          return `- ${f.Name}  [assignmentId=${f.Id}; ${due}${files}${group}]`;
        }),
      ].join("\n");
    },
  },
  {
    name: "get_assignment",
    title: "Assignment details",
    description:
      "Shows an assignment's full instructions, attached files (with fileIds for read_file), links, rubric names, and the user's own submission status and feedback, including feedback files (with feedbackFileIds for read_file).",
    inputSchema: {
      type: "object",
      properties: { course: COURSE_ARG, assignment_id: { type: "number", description: "assignmentId from list_assignments." } },
      required: ["course", "assignment_id"],
      additionalProperties: false,
    },
    async run(args) {
      const course = await learn.resolveCourse(requireStr(args, "course"));
      const id = int(args, "assignment_id")!;
      const { folder: f, mine } = await learn.getAssignment(course.id, id);
      const lines = [
        `${f.Name}  [assignmentId=${f.Id}] in ${courseLabel(course)}`,
        `Due: ${f.DueDate ? fmtDate(f.DueDate) : "no due date"}`,
      ];
      if (f.Availability?.EndDate) lines.push(`Closes: ${fmtDate(f.Availability.EndDate)}`);
      if (f.GroupTypeId) lines.push("Group hand-in.");
      if (f.Assessment?.ScoreDenominator) lines.push(`Out of: ${f.Assessment.ScoreDenominator} points`);
      if (f.Assessment?.Rubrics?.length) lines.push(`Rubrics: ${f.Assessment.Rubrics.map((r) => r.Name ?? "unnamed").join(", ")}`);
      const instructions = richText(f.CustomInstructions);
      lines.push("", "Instructions:", instructions || "(none)");
      if (f.Attachments?.length) {
        lines.push("", "Attached files (read with read_file using assignment_id + file_id):");
        for (const a of f.Attachments) lines.push(`- ${a.FileName}  [fileId=${a.FileId}; ${(a.Size / 1024).toFixed(0)} KB]`);
      }
      if (f.LinkAttachments?.length) {
        lines.push("", "Links:");
        for (const l of f.LinkAttachments) lines.push(`- ${l.LinkName}: ${l.Href}`);
      }
      if (mine) {
        const subs = mine.flatMap((e) => e.Submissions ?? []);
        lines.push("", subs.length ? `Your submissions: ${subs.length}` : "You have not submitted anything yet.");
        for (const s of subs) {
          lines.push(`- ${fmtDate(s.SubmissionDate)}: ${(s.Files ?? []).map((x) => x.FileName).join(", ") || "(no files)"}`);
        }
        const fb = mine.find((e) => e.Feedback)?.Feedback;
        if (fb && (fb.Score != null || fb.Feedback)) {
          lines.push(`Feedback${fb.Score != null ? ` (score ${fb.Score})` : ""}: ${richText(fb.Feedback) || "(no text)"}`);
        }
        const fbFiles = mine.flatMap((e) => e.Feedback?.Files ?? []);
        if (fbFiles.length) {
          lines.push("", "Feedback files (read with read_file using assignment_id + feedback_file_id):");
          for (const x of fbFiles) lines.push(`- ${x.FileName}  [feedbackFileId=${x.FileId}; ${(x.Size / 1024).toFixed(0)} KB]`);
        }
      }
      lines.push("", `Open in DTU Learn: ${BASE_URL}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=${course.id}&db=${f.Id}`);
      return lines.join("\n");
    },
  },
  {
    name: "get_topic",
    title: "Content item details",
    description:
      "Shows details for one content item (topicId from get_course_outline): description, dates, and the URL for links, videos and external tools such as Panopto. Use read_file instead to read the contents of a file.",
    inputSchema: {
      type: "object",
      properties: { course: COURSE_ARG, topic_id: { type: "number", description: "topicId from get_course_outline." } },
      required: ["course", "topic_id"],
      additionalProperties: false,
    },
    async run(args) {
      const course = await learn.resolveCourse(requireStr(args, "course"));
      const id = int(args, "topic_id")!;
      const t = await learn.getTopic(course.id, id);
      const lines = [`${t.Title}  [topicId=${t.Id}; ${topicKind(t.ActivityType, t.Url ?? undefined)}] in ${courseLabel(course)}`];
      if (t.StartDate) lines.push(`Available from: ${fmtDate(t.StartDate)}`);
      if (t.EndDate) lines.push(`Available until: ${fmtDate(t.EndDate)}`);
      if (t.DueDate) lines.push(`Due: ${fmtDate(t.DueDate)}`);
      if (t.Url && !isMediaRef(t.Url)) lines.push(`URL: ${t.Url.startsWith("/") ? BASE_URL + t.Url : t.Url}`);
      const desc = richText(t.Description);
      if (desc) lines.push("", desc);
      if (t.TopicType === 1) lines.push("", `This is a file. Read it with read_file (course="${course.id}", topic_id=${t.Id}).`);
      lines.push("", `Open in DTU Learn: ${BASE_URL}/d2l/le/content/${course.id}/viewContent/${t.Id}/View`);
      return lines.join("\n");
    },
  },
  {
    name: "read_file",
    title: "Read a course file",
    description:
      "Downloads a file from DTU Learn to the user's computer and returns its text (PDF, PowerPoint incl. speaker notes, Word, notebooks, code, text). Give either topic_id (course content), assignment_id + file_id (assignment attachment), or assignment_id + feedback_file_id (a file in the user's feedback, e.g. their hand-in with the teacher's comments). Long files are paged: use offset to continue. The saved path is returned so a coding agent can also open the original.",
    inputSchema: {
      type: "object",
      properties: {
        course: COURSE_ARG,
        topic_id: { type: "number", description: "topicId of a file from get_course_outline." },
        assignment_id: { type: "number", description: "assignmentId, for an assignment attachment." },
        file_id: { type: "number", description: "fileId of the attachment from get_assignment." },
        feedback_file_id: { type: "number", description: "feedbackFileId of a feedback file from get_assignment." },
        offset: { type: "number", description: "Character offset to start from (default 0)." },
        max_chars: { type: "number", description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}).` },
      },
      required: ["course"],
      additionalProperties: false,
    },
    async run(args) {
      const course = await learn.resolveCourse(requireStr(args, "course"));
      const offset = Math.max(int(args, "offset", 0)!, 0);
      const maxChars = Math.min(Math.max(int(args, "max_chars", DEFAULT_MAX_CHARS)!, 1000), 200_000);
      const topicId = int(args, "topic_id");
      const assignmentId = int(args, "assignment_id");
      const fileId = int(args, "file_id");
      const feedbackFileId = int(args, "feedback_file_id");
      let result: FileResult;
      if (topicId !== undefined) {
        result = await learn.getTopicFile(course, topicId);
      } else if (assignmentId !== undefined && fileId !== undefined) {
        result = await learn.getAssignmentFile(course, assignmentId, fileId);
      } else if (assignmentId !== undefined && feedbackFileId !== undefined) {
        result = await learn.getFeedbackFile(course, assignmentId, feedbackFileId);
      } else {
        throw new Error("Give either topic_id, or assignment_id together with file_id or feedback_file_id.");
      }
      return formatFile(result, offset, maxChars);
    },
  },
  {
    name: "get_announcements",
    title: "Recent announcements",
    description: "Shows recent announcements (news) from all courses, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        course: { ...COURSE_ARG, description: `${COURSE_ARG.description} Omit for all courses.` },
        days: { type: "number", description: "How many days back to look (default 14)." },
      },
      additionalProperties: false,
    },
    async run(args) {
      const days = Math.min(Math.max(int(args, "days", 14)!, 1), 365);
      const items = await learn.getAnnouncements(days, str(args, "course"));
      if (items.length === 0) return `No announcements in the last ${days} days.`;
      return items
        .slice(0, 40)
        .map(({ course, item }) => {
          const files = item.Attachments?.length ? `\nAttachments: ${item.Attachments.map((a) => a.FileName).join(", ")}` : "";
          return `## ${item.Title}\n${courseLabel(course)} · ${fmtDate(item.StartDate)}\n\n${truncate(richText(item.Body), 3000)}${files}`;
        })
        .join("\n\n");
    },
  },
];

export function findTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
