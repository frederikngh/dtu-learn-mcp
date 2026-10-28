/** DTU Learn concepts (courses, content, assignments, ...) on top of the raw API client. */
import fs from "node:fs";
import path from "node:path";
import { DOWNLOAD_DIR } from "./config.js";
import { ApiError, DtuLearnClient } from "./client.js";
import { extractText, type Extracted } from "./extract.js";
import { richText, safeFileName } from "./text.js";

// ---- Brightspace response shapes (only the fields we use) ----------------

interface Enrollment {
  OrgUnit: { Id: number; Name: string; Code: string | null; Type: { Id: number; Code: string } };
  Access: { IsActive: boolean; CanAccess: boolean; StartDate: string | null; EndDate: string | null; ClasslistRoleName?: string };
}

export interface TocTopic {
  TopicId: number;
  Title: string;
  Url?: string;
  TypeIdentifier?: string;
  ActivityType?: number;
  Unread?: boolean;
  IsHidden?: boolean;
  IsBroken?: boolean;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  LastModifiedDate?: string | null;
  SortOrder?: number;
  ToolItemId?: number | null;
}

export interface TocModule {
  ModuleId: number;
  Title: string;
  SortOrder?: number;
  StartDateTime?: string | null;
  EndDateTime?: string | null;
  IsHidden?: boolean;
  Modules?: TocModule[];
  Topics?: TocTopic[];
  LastModifiedDate?: string | null;
}

export interface ContentTopic {
  Id: number;
  Title: string;
  TopicType: number;
  Url: string | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  Description?: { Text?: string; Html?: string } | null;
  ActivityType?: number;
  OpenAsExternalResource?: boolean | null;
}

export interface DropboxFolder {
  Id: number;
  Name: string;
  CustomInstructions?: { Text?: string; Html?: string } | null;
  Attachments?: { FileId: number; FileName: string; Size: number }[];
  LinkAttachments?: { LinkId: number; LinkName: string; Href: string }[];
  DueDate: string | null;
  Availability?: { StartDate: string | null; EndDate: string | null } | null;
  IsHidden?: boolean;
  GroupTypeId?: number | null;
  Assessment?: { ScoreDenominator: number | null; Rubrics?: { Name?: string }[] } | null;
}

export interface EntityDropbox {
  /** The user, or the group for group hand-ins; feedback files are fetched through it. */
  Entity?: { EntityId: number; EntityType: string; Name?: string };
  Status?: string | number;
  Submissions?: { Id: number; SubmissionDate: string | null; Files?: { FileId: number; FileName: string; Size: number }[] }[];
  Feedback?: {
    Score?: number | null;
    Feedback?: { Text?: string; Html?: string } | null;
    IsGraded?: boolean;
    Files?: { FileId: number; FileName: string; Size: number }[];
  } | null;
}

interface ScheduledItem {
  OrgUnitId: string | number;
  ItemId: number;
  ItemName: string;
  ItemType: number;
  ItemUrl: string | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  DateCompleted: string | null;
  ActivityType: number;
}

interface CalendarEvent {
  CalendarEventId: number;
  OrgUnitId: number;
  OrgUnitName?: string;
  OrgUnitCode?: string;
  Title: string;
  Description?: string;
  StartDateTime: string | null;
  EndDateTime: string | null;
  IsAllDayEvent?: boolean;
  StartDay?: string | null;
  LocationName?: string;
  AssociatedEntity?: { AssociatedEntityType?: string; AssociatedEntityId?: number } | null;
  CalendarEventViewUrl?: string;
}

interface NewsItem {
  Id: number;
  Title: string;
  Body?: { Text?: string; Html?: string };
  StartDate: string | null;
  IsHidden?: boolean;
  IsPublished?: boolean;
  Attachments?: { FileId: number; FileName: string }[];
}

// ---- our own shapes --------------------------------------------------------

export interface Course {
  id: number;
  code: string;
  name: string;
  isActive: boolean;
  startDate: string | null;
  endDate: string | null;
  role?: string;
}

export interface UpcomingItem {
  date: string;
  courseId: number;
  courseLabel: string;
  title: string;
  kind: string;
  ref?: string;
  location?: string;
}

export interface FileResult {
  savedTo: string;
  filename: string;
  bytes: number;
  extracted: Extracted | null;
}

export const ACTIVITY_TYPES: Record<number, string> = {
  0: "module", 1: "file", 2: "link", 3: "assignment", 4: "quiz", 5: "discussion forum",
  6: "discussion topic", 7: "external tool (LTI)", 9: "schedule", 10: "checklist", 11: "self-assessment",
  12: "survey", 14: "course link", 20: "SCORM", 21: "SCORM", 22: "SCORM", 23: "SCORM", 24: "SCORM",
  25: "learning object", 26: "learning object", 27: "external tool (LTI)", 28: "org unit",
};

const CACHE_MS = 5 * 60_000;

/** When a DTU semester named in a course title ("..., Fall 2026") is over, including exams and the 3-week period. */
const SEMESTER_END: Record<string, (year: number) => string> = {
  spring: (y) => `${y}-07-01`,
  summer: (y) => `${y}-09-01`,
  fall: (y) => `${y + 1}-02-01`,
  autumn: (y) => `${y + 1}-02-01`,
};

/** DTU keeps courses open for 5 years, so EndDate says little; the semester in the name says when a course is over. */
function isCurrent(c: Course, now: string): boolean {
  if (!c.isActive) return false;
  const semester = /\b(spring|summer|fall|autumn)\s+(\d{4})\b/i.exec(c.name);
  if (semester) return now < SEMESTER_END[semester[1].toLowerCase()](Number(semester[2]));
  return !c.endDate || c.endDate > now;
}

export class DtuLearn {
  private coursesCache: { at: number; courses: Course[] } | null = null;
  private tocCache = new Map<number, { at: number; modules: TocModule[] }>();

  constructor(public client = new DtuLearnClient()) {}

  // ---- courses -------------------------------------------------------------

  async listCourses(includeInactive = false): Promise<Course[]> {
    if (!this.coursesCache || Date.now() - this.coursesCache.at > CACHE_MS) {
      const items = await this.client.getPagedResultSet<Enrollment>(
        await this.client.lp("/enrollments/myenrollments/?orgUnitTypeId=3"),
      );
      const courses = items
        .filter((e) => e.Access.CanAccess)
        .map((e) => ({
          id: e.OrgUnit.Id,
          code: e.OrgUnit.Code ?? "",
          name: e.OrgUnit.Name,
          isActive: e.Access.IsActive,
          startDate: e.Access.StartDate,
          endDate: e.Access.EndDate,
          role: e.Access.ClasslistRoleName,
        }))
        .sort((a, b) => Number(b.isActive) - Number(a.isActive) || (b.startDate ?? "").localeCompare(a.startDate ?? ""));
      this.coursesCache = { at: Date.now(), courses };
    }
    const all = this.coursesCache.courses;
    if (includeInactive) return all;
    const now = new Date().toISOString();
    return all.filter((c) => isCurrent(c, now));
  }

  /** Accepts an org unit id, a DTU course number like "02450", or part of the course name. */
  async resolveCourse(ref: string | number): Promise<Course> {
    const all = await this.listCourses(true);
    const s = String(ref).trim();
    // DTU course numbers have 5 digits (e.g. 02450); Brightspace org unit ids are usually longer.
    const byId = /^\d+$/.test(s) ? all.find((c) => String(c.id) === s) : undefined;
    if (byId && s.length !== 5) return byId;
    const needle = s.toLowerCase();
    const matches = all.filter(
      (c) => c.code.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle),
    );
    if (matches.length === 0) {
      if (byId) return byId;
      const current = (await this.listCourses()).map((c) => `${c.name} [${c.id}]`).join("; ");
      throw new Error(`No course matching "${s}". Current courses: ${current || "none found"}`);
    }
    // Prefer the current run of a course over older semesters.
    const now = new Date().toISOString();
    matches.sort(
      (a, b) => Number(isCurrent(b, now)) - Number(isCurrent(a, now)) || (b.startDate ?? "").localeCompare(a.startDate ?? ""),
    );
    return matches[0];
  }

  // ---- content -------------------------------------------------------------

  async getToc(courseId: number): Promise<TocModule[]> {
    const hit = this.tocCache.get(courseId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.modules;
    const toc = await this.client.getJson<{ Modules: TocModule[] }>(await this.client.le(`/${courseId}/content/toc`));
    const modules = toc.Modules ?? [];
    this.tocCache.set(courseId, { at: Date.now(), modules });
    return modules;
  }

  async getTopic(courseId: number, topicId: number): Promise<ContentTopic> {
    return this.client.getJson(await this.client.le(`/${courseId}/content/topics/${topicId}`));
  }

  async getOverview(courseId: number): Promise<{ text: string; hasAttachment: boolean } | null> {
    try {
      const o = await this.client.getJson<{ Description?: { Text?: string; Html?: string }; HasAttachment?: boolean }>(
        await this.client.le(`/${courseId}/overview`),
      );
      return { text: richText(o.Description), hasAttachment: Boolean(o.HasAttachment) };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  async getTopicFile(course: Course, topicId: number, opts: { save?: boolean } = {}): Promise<FileResult> {
    const bin = await this.client.getBinary(await this.client.le(`/${course.id}/content/topics/${topicId}/file`));
    let filename = bin.filename;
    if (!filename) {
      try {
        const topic = await this.getTopic(course.id, topicId);
        filename = path.basename(decodeURIComponent(topic.Url ?? "")) || topic.Title;
      } catch {
        filename = `topic-${topicId}`;
      }
    }
    return this.finishFile(course, filename, bin.data, bin.contentType, opts.save ?? true);
  }

  // ---- assignments ---------------------------------------------------------

  async listAssignments(courseId: number): Promise<DropboxFolder[]> {
    const folders = await this.client.getJson<DropboxFolder[]>(await this.client.le(`/${courseId}/dropbox/folders/`));
    return folders
      .filter((f) => !f.IsHidden)
      .sort((a, b) => (a.DueDate ?? "9999").localeCompare(b.DueDate ?? "9999"));
  }

  async getAssignment(courseId: number, folderId: number): Promise<{ folder: DropboxFolder; mine: EntityDropbox[] | null }> {
    const folder = await this.client.getJson<DropboxFolder>(await this.client.le(`/${courseId}/dropbox/folders/${folderId}`));
    let mine: EntityDropbox[] | null = null;
    try {
      const raw = await this.client.getJson<EntityDropbox[] | EntityDropbox>(
        await this.client.le(`/${courseId}/dropbox/folders/${folderId}/submissions/mysubmissions/`),
      );
      mine = Array.isArray(raw) ? raw : [raw];
    } catch {
      mine = null; // not available for every role / API version
    }
    return { folder, mine };
  }

  async getAssignmentFile(course: Course, folderId: number, fileId: number, opts: { save?: boolean } = {}): Promise<FileResult> {
    const bin = await this.client.getBinary(
      await this.client.le(`/${course.id}/dropbox/folders/${folderId}/attachments/${fileId}`),
    );
    let filename = bin.filename;
    if (!filename) {
      const { folder } = await this.getAssignment(course.id, folderId);
      filename = folder.Attachments?.find((a) => a.FileId === fileId)?.FileName ?? `attachment-${fileId}`;
    }
    return this.finishFile(course, filename, bin.data, bin.contentType, opts.save ?? true);
  }

  /** A file the teacher attached to the user's (or their group's) feedback, e.g. a commented copy of the hand-in. */
  async getFeedbackFile(course: Course, folderId: number, fileId: number, opts: { save?: boolean } = {}): Promise<FileResult> {
    const { mine } = await this.getAssignment(course.id, folderId);
    const entry = mine?.find((e) => e.Feedback?.Files?.some((f) => f.FileId === fileId));
    if (!entry?.Entity) throw new Error(`No feedback file ${fileId} on assignment ${folderId}. get_assignment lists the feedback files.`);
    const { EntityType, EntityId } = entry.Entity;
    const bin = await this.client.getBinary(
      await this.client.le(`/${course.id}/dropbox/folders/${folderId}/feedback/${EntityType.toLowerCase()}/${EntityId}/attachments/${fileId}`),
    );
    const filename = bin.filename ?? entry.Feedback!.Files!.find((f) => f.FileId === fileId)!.FileName;
    // Prefixed so a returned copy of a hand-out (same file name) does not overwrite the saved hand-out.
    return this.finishFile(course, `feedback_${filename}`, bin.data, bin.contentType, opts.save ?? true);
  }

  /** A file the user (or their group) handed in. */
  async getSubmissionFile(course: Course, folderId: number, fileId: number, opts: { save?: boolean } = {}): Promise<FileResult> {
    const { mine } = await this.getAssignment(course.id, folderId);
    const sub = mine?.flatMap((e) => e.Submissions ?? []).find((s) => s.Files?.some((f) => f.FileId === fileId));
    if (!sub) throw new Error(`No submitted file ${fileId} on assignment ${folderId}. get_assignment lists the submitted files.`);
    const bin = await this.client.getBinary(
      await this.client.le(`/${course.id}/dropbox/folders/${folderId}/submissions/${sub.Id}/files/${fileId}`),
    );
    const filename = bin.filename ?? sub.Files!.find((f) => f.FileId === fileId)!.FileName;
    // Prefixed like feedback files, so a hand-in named like the hand-out does not overwrite it.
    return this.finishFile(course, `submission_${filename}`, bin.data, bin.contentType, opts.save ?? true);
  }

  // ---- upcoming / calendar --------------------------------------------------

  async getUpcoming(days: number, courseRef?: string, includeCompleted = false): Promise<{ items: UpcomingItem[]; warnings: string[] }> {
    // All courses, not just this semester's: some DTU courses run over two semesters, and the date window filters anyway.
    const courses = courseRef ? [await this.resolveCourse(courseRef)] : await this.listCourses(true);
    const warnings: string[] = [];
    if (courses.length === 0) return { items: [], warnings: ["No active courses found."] };
    const byId = new Map(courses.map((c) => [c.id, c]));
    const ids = courses.slice(0, 100).map((c) => c.id).join(",");
    const start = new Date();
    const end = new Date(start.getTime() + days * 86_400_000);
    const window = `startDateTime=${encodeURIComponent(start.toISOString())}&endDateTime=${encodeURIComponent(end.toISOString())}`;
    const items: UpcomingItem[] = [];

    try {
      const completion = includeCompleted ? "" : "&completion=3";
      const scheduled = await this.client.getObjectListPages<ScheduledItem>(
        await this.client.le(`/content/myItems/?orgUnitIdsCSV=${ids}&${window}${completion}`),
      );
      for (const s of scheduled) {
        const date = s.DueDate ?? s.EndDate ?? s.StartDate;
        if (!date) continue;
        const course = byId.get(Number(s.OrgUnitId));
        const which = s.DueDate ? "due" : s.EndDate ? "closes" : "opens";
        items.push({
          date,
          courseId: Number(s.OrgUnitId),
          courseLabel: course ? courseLabel(course) : String(s.OrgUnitId),
          title: s.ItemName,
          kind: `${ACTIVITY_TYPES[s.ActivityType] ?? "item"} ${which}`,
          ref: s.ItemType === 1 ? `topicId=${s.ItemId}` : undefined,
        });
      }
    } catch (err) {
      warnings.push(`Scheduled content items unavailable: ${(err as Error).message}`);
    }

    try {
      const events = await this.client.getObjectListPages<CalendarEvent>(
        await this.client.le(`/calendar/events/myEvents/?orgUnitIdsCSV=${ids}&${window}`),
      );
      for (const e of events) {
        const date = e.StartDateTime ?? e.StartDay;
        if (!date) continue;
        const course = byId.get(e.OrgUnitId);
        const entity = e.AssociatedEntity?.AssociatedEntityType ?? "";
        const kind = entity.includes("Dropbox")
          ? "assignment"
          : entity.includes("Quiz")
            ? "quiz"
            : entity.includes("Content")
              ? "content"
              : "calendar event";
        items.push({
          date,
          courseId: e.OrgUnitId,
          courseLabel: course ? courseLabel(course) : (e.OrgUnitCode ?? e.OrgUnitName ?? String(e.OrgUnitId)),
          title: e.Title,
          kind,
          ref:
            entity.includes("Dropbox") && e.AssociatedEntity?.AssociatedEntityId
              ? `assignmentId=${e.AssociatedEntity.AssociatedEntityId}`
              : undefined,
          location: e.LocationName || undefined,
        });
      }
    } catch (err) {
      warnings.push(`Calendar unavailable: ${(err as Error).message}`);
    }

    // The same deadline often shows up both as a content item and as a calendar event.
    const seen = new Set<string>();
    const deduped = items
      .sort((a, b) => a.date.localeCompare(b.date))
      .filter((i) => {
        const key = `${i.courseId}|${i.title.toLowerCase().replace(/\s*-\s*due$/i, "")}|${i.date.slice(0, 16)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return { items: deduped, warnings };
  }

  // ---- announcements -------------------------------------------------------

  async getAnnouncements(days: number, courseRef?: string): Promise<{ course: Course; item: NewsItem }[]> {
    // All courses, for the same reason as getUpcoming.
    const courses = courseRef ? [await this.resolveCourse(courseRef)] : await this.listCourses(true);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const out: { course: Course; item: NewsItem }[] = [];
    await Promise.all(
      courses.map(async (course) => {
        try {
          const news = await this.client.getJson<NewsItem[]>(await this.client.le(`/${course.id}/news/`));
          for (const item of news) {
            if (item.IsHidden || item.IsPublished === false) continue;
            if (item.StartDate && item.StartDate < since) continue;
            out.push({ course, item });
          }
        } catch {
          // Some courses have announcements disabled.
        }
      }),
    );
    return out.sort((a, b) => (b.item.StartDate ?? "").localeCompare(a.item.StartDate ?? ""));
  }

  // ---- helpers -------------------------------------------------------------

  private async finishFile(course: Course, filename: string, data: Buffer, contentType: string, save: boolean): Promise<FileResult> {
    let savedTo = "";
    if (save) {
      const dir = path.join(DOWNLOAD_DIR, safeFileName(courseLabel(course)));
      fs.mkdirSync(dir, { recursive: true });
      savedTo = path.join(dir, safeFileName(filename));
      fs.writeFileSync(savedTo, data);
    }
    let extracted: Extracted | null = null;
    try {
      extracted = await extractText(data, filename, contentType);
    } catch (err) {
      extracted = { text: "", kind: `could not extract text: ${(err as Error).message}` };
    }
    return { savedTo, filename, bytes: data.length, extracted };
  }
}

export function courseLabel(c: Course): string {
  const num = /\b(\d{5})\b/.exec(`${c.code} ${c.name}`)?.[1];
  if (num && !c.name.includes(num)) return `${num} ${c.name}`;
  return c.name;
}
