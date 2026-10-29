// A tiny fake Brightspace server used by the tests. It only knows the routes this project calls.
import http from "node:http";
import JSZip from "jszip";

export async function makePptx() {
  const zip = new JSZip();
  const slide = (t) =>
    `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p><a:p><a:r><a:t>Bias &amp; variance</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  zip.file("ppt/slides/slide2.xml", slide("Second slide"));
  zip.file("ppt/slides/slide1.xml", slide("Lecture 5: Regularization"));
  zip.file("ppt/notesSlides/notesSlide1.xml", `<p:notes xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>Remember to mention ridge</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

// Course names carry the DTU semester, which decides whether a course is current (DTU end dates are 5 years out).
const year = new Date().getFullYear();
export const CURRENT_SEMESTER = `Fall ${year}`; // never over during this calendar year
export const OLD_SEMESTER = `Spring ${year - 1}`;

/**
 * mode "cookie": API accepts the session cookie directly.
 * mode "bearer": API rejects cookies (403) and needs a token minted from the session.
 */
export async function startFakeBrightspace({ mode = "cookie" } = {}) {
  const pptx = await makePptx();
  const LP = "1.50";
  const LE = "1.88";
  const now = Date.now();
  const inDays = (d) => new Date(now + d * 86400000).toISOString();
  const calls = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    const cookieOk = /d2lSessionVal=good/.test(req.headers.cookie ?? "");
    const bearerOk = req.headers.authorization === "Bearer tok123";
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // What DTU Learn sends for an expired session, on every API path: never a 401 or a redirect.
    const authRequired = () => {
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      res.end("Authentication required");
    };
    const forOrgUnits = (objects) => {
      const ids = (url.searchParams.get("orgUnitIdsCSV") ?? "").split(",");
      return objects.filter((o) => ids.includes(String(o.OrgUnitId)));
    };

    if (req.method === "POST" && url.pathname === "/d2l/lp/auth/oauth2/token") {
      if (cookieOk && req.headers["x-csrf-token"] === "xsrf-1") return json(200, { access_token: "tok123", expires_at: Math.floor(now / 1000) + 3600 });
      return json(403, {});
    }
    if (req.method !== "GET") return json(405, { error: "read-only test server got a write" });

    if (req.headers.cookie && !cookieOk) return authRequired(); // even /versions/, which is otherwise public
    if (url.pathname === "/d2l/api/versions/") {
      return json(200, [
        { ProductCode: "lp", LatestVersion: LP, SupportedVersions: ["1.48", LP] },
        { ProductCode: "le", LatestVersion: LE, SupportedVersions: ["1.82", LE] },
      ]);
    }

    // Web pages and course files (not the API) always take the session cookie.
    if (url.pathname === "/content/enforced/111111/uge5_warmup.pptx") {
      if (!cookieOk) return authRequired();
      res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
      return res.end(pptx);
    }
    if (url.pathname === "/d2l/common/dialogs/quickLink/quickLink.d2l") {
      if (!cookieOk) return authRequired();
      res.writeHead(302, { location: `/d2l/le/content/111111/viewContent/501/View` });
      return res.end();
    }

    const authed = mode === "cookie" ? cookieOk : bearerOk;
    if (!authed) {
      if (mode === "bearer" && cookieOk) return json(403, { title: "Not Authorized" });
      return authRequired();
    }

    const p = url.pathname;
    if (p === `/d2l/api/lp/${LP}/users/whoami`) return json(200, { Identifier: "1", FirstName: "Test", LastName: "Student", UniqueName: "s123456" });
    if (p === `/d2l/api/lp/${LP}/enrollments/myenrollments/`) {
      const page1 = {
        PagingInfo: { Bookmark: "b1", HasMoreItems: true },
        Items: [
          { OrgUnit: { Id: 111111, Name: `02450 Introduction to Machine Learning, ${CURRENT_SEMESTER}`, Code: "DTU_e26_02450", Type: { Id: 3, Code: "Course Offering" } }, Access: { IsActive: true, CanAccess: true, StartDate: inDays(-40), EndDate: inDays(1800) } },
          { OrgUnit: { Id: 100000, Name: `02450 Introduction to Machine Learning, ${OLD_SEMESTER}`, Code: "DTU_f25_02450", Type: { Id: 3, Code: "Course Offering" } }, Access: { IsActive: true, CanAccess: true, StartDate: inDays(-500), EndDate: inDays(1300) } },
        ],
      };
      const page2 = {
        PagingInfo: { Bookmark: null, HasMoreItems: false },
        Items: [{ OrgUnit: { Id: 222222, Name: "Linear Algebra", Code: "01005E26", Type: { Id: 3, Code: "Course Offering" } }, Access: { IsActive: true, CanAccess: true, StartDate: inDays(-40), EndDate: inDays(60) } }],
      };
      return json(200, url.searchParams.get("bookmark") === "b1" ? page2 : page1);
    }
    if (p === `/d2l/api/le/${LE}/111111/overview`) return json(200, { Description: { Html: "<p>Welcome to <b>02450</b>!</p>" }, HasAttachment: false });
    if (p === `/d2l/api/le/${LE}/111111/content/toc`) {
      return json(200, {
        Modules: [
          {
            ModuleId: 10, Title: "Week 5", SortOrder: 5, Modules: [],
            Topics: [
              { TopicId: 501, Title: "Lecture 5 slides", Url: "/content/enforced/111111/lec5.pptx", ActivityType: 1, SortOrder: 1, Unread: true },
              { TopicId: 502, Title: "Panopto recording", Url: "https://panopto.example/x", ActivityType: 27, SortOrder: 2 },
              { TopicId: 503, Title: "video123.mp4", TypeIdentifier: "ContentService", Url: "d2l:brightspace:content:eu-west-1:abc:video:def/latest", ActivityType: 1, SortOrder: 3 },
            ],
          },
          {
            // Newer API versions put the module's page text in the TOC; older ones need content/modules/{id}.
            ModuleId: 15, Title: "Week 15- Recap", SortOrder: 15, Topics: [], Description: { Text: "Recap of the course.", Html: "<p>Recap of the course.</p>" },
            Modules: [
              { ModuleId: 16, Title: "Slides", SortOrder: 1, Modules: [], Topics: [{ TopicId: 504, Title: "02450_Lecture_15", Url: "/content/enforced/111111/02450_Lecture_15.pdf", ActivityType: 1, SortOrder: 1 }] },
            ],
          },
        ],
      });
    }
    if (p === `/d2l/api/le/${LE}/111111/content/modules/10`) {
      return json(200, {
        Id: 10, Title: "Week 5", ModuleStartDate: null, ModuleEndDate: null, ModuleDueDate: null, IsHidden: false, IsLocked: false, Structure: [],
        Description: { Text: "", Html: '<p><strong>Reading:</strong> Chapter 5.3&ndash;5.4.</p><p><strong>Exercises:</strong> 114, 149.</p><p><a href="/content/enforced/111111/uge5_warmup.pptx">Warm-up exercises</a></p>' },
      });
    }
    if (p === `/d2l/api/le/${LE}/111111/content/topics/503`) return json(200, { Id: 503, Title: "video123.mp4", TopicType: 11, Url: "d2l:brightspace:content:eu-west-1:abc:video:def/latest", StartDate: null, EndDate: null, DueDate: null, ActivityType: 1 });
    if (p === `/d2l/api/le/${LE}/111111/content/topics/501/file`) {
      res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "content-disposition": 'attachment; filename="lec5.pptx"' });
      return res.end(pptx);
    }
    if (p === `/d2l/api/le/${LE}/111111/content/topics/502`) return json(200, { Id: 502, Title: "Panopto recording", TopicType: 3, Url: "https://panopto.example/x", StartDate: null, EndDate: null, DueDate: null, ActivityType: 27 });
    if (p === `/d2l/api/le/${LE}/111111/dropbox/folders/`) {
      return json(200, [
        { Id: 7, Name: "Project 1", DueDate: inDays(3), Attachments: [{ FileId: 70, FileName: "spec.pptx", Size: 2048 }], IsHidden: false },
        { Id: 8, Name: "Hidden draft", DueDate: inDays(1), IsHidden: true },
        { Id: 11, Name: "Assignment 0", DueDate: inDays(-10), GroupTypeId: 1, IsHidden: false },
      ]);
    }
    if (p === `/d2l/api/le/${LE}/111111/dropbox/folders/11`) return json(200, { Id: 11, Name: "Assignment 0", DueDate: inDays(-10), GroupTypeId: 1, CustomInstructions: { Html: "" }, Attachments: [], LinkAttachments: [], IsHidden: false });
    if (p === `/d2l/api/le/${LE}/111111/dropbox/folders/11/submissions/mysubmissions/`) {
      return json(200, [
        {
          Entity: { Name: "Group 9", EntityId: 342, EntityType: "Group", Active: true },
          Status: 3,
          Feedback: { Files: [{ FileId: 90, FileName: "grp9_assignment_0.ipynb", Size: 4096 }], Links: [], Score: null, Feedback: { Html: "<p>See the comments in the file.</p>" }, IsGraded: true },
          Submissions: [{ Id: 1, SubmissionDate: inDays(-11), Files: [{ FileId: 80, FileName: "assignment_0.ipynb", Size: 3072 }] }],
        },
      ]);
    }
    if (p === `/d2l/api/le/${LE}/111111/dropbox/folders/11/submissions/1/files/80`) {
      const nb = { cells: [{ cell_type: "code", source: "x = conv(img, k)" }] };
      res.writeHead(200, { "content-type": "d2l/unknowntype", "content-disposition": 'attachment; filename="assignment_0.ipynb"' });
      return res.end(JSON.stringify(nb));
    }
    // Like DTU Learn: a feedback file is only served through the entity (here the group) that got the feedback.
    if (p.startsWith(`/d2l/api/le/${LE}/111111/dropbox/folders/11/feedback/`)) {
      if (p !== `/d2l/api/le/${LE}/111111/dropbox/folders/11/feedback/group/342/attachments/90`) return json(403, { Errors: [{ Message: "Forbidden" }] });
      const nb = { cells: [{ cell_type: "code", source: "x = conv(img, k)" }, { cell_type: "markdown", source: "TA: explain why you chose this kernel" }] };
      res.writeHead(200, { "content-type": "d2l/unknowntype", "content-disposition": 'attachment; filename="grp9_assignment_0.ipynb"' });
      return res.end(JSON.stringify(nb));
    }
    if (p === `/d2l/api/le/${LE}/111111/dropbox/folders/7`) return json(200, { Id: 7, Name: "Project 1", DueDate: inDays(3), CustomInstructions: { Html: "<p>Write a <i>report</i>.</p><ul><li>Max 10 pages</li></ul>" }, Attachments: [{ FileId: 70, FileName: "spec.pptx", Size: 2048 }], LinkAttachments: [], IsHidden: false });
    if (p === `/d2l/api/le/${LE}/111111/dropbox/folders/7/submissions/mysubmissions/`) return json(200, []);
    if (p === `/d2l/api/le/${LE}/111111/dropbox/folders/7/attachments/70`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(pptx);
    }
    if (p === `/d2l/api/le/${LE}/content/myItems/`) {
      return json(200, { Objects: forOrgUnits([{ OrgUnitId: "111111", ItemId: 501, ItemName: "Lecture 5 slides", ItemType: 1, ItemUrl: null, StartDate: null, EndDate: null, DueDate: inDays(2), DateCompleted: null, ActivityType: 1 }]), Next: null });
    }
    if (p === `/d2l/api/le/${LE}/calendar/events/myEvents/`) {
      return json(200, {
        Objects: forOrgUnits([
          { CalendarEventId: 1, OrgUnitId: 111111, Title: "Project 1 - Due", StartDateTime: inDays(3), EndDateTime: inDays(3), AssociatedEntity: { AssociatedEntityType: "D2L.LE.Dropbox.Dropbox", AssociatedEntityId: 7 } },
          // DTU copies its timetable into the calendar.
          { CalendarEventId: 2, OrgUnitId: 111111, Title: "Lecture", StartDateTime: inDays(1), EndDateTime: inDays(1), LocationName: "LYN.303A.AUD41.R:001", AssociatedEntity: null },
          // Some courses run over two semesters, so an older course can still have deadlines.
          { CalendarEventId: 3, OrgUnitId: 100000, Title: "Lab 3 - Due", StartDateTime: inDays(4), EndDateTime: inDays(4), AssociatedEntity: { AssociatedEntityType: "D2L.LE.Dropbox.Dropbox", AssociatedEntityId: 9 } },
        ]),
        Next: null,
      });
    }
    if (/\/news\/$/.test(p)) {
      if (p.includes("/111111/")) return json(200, [{ Id: 1, Title: "Room change", Body: { Html: "<p>Lecture moves to <b>B116</b>.</p>" }, StartDate: inDays(-1), IsPublished: true }]);
      if (p.includes("/100000/")) return json(200, [{ Id: 2, Title: "Lab 3 extended", Body: { Text: "One more week." }, StartDate: inDays(-2), IsPublished: true }]);
      return json(200, []);
    }
    return json(404, { title: "Not Found", path: p });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(r)) };
}
