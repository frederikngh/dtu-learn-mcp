# DTU Learn MCP (unofficial)

Let your AI assistant see your **DTU Learn** courses: lecture slides, course material, assignments, deadlines and announcements. Ask things like:

> "What do I need to prepare for Thursday's 02450 lecture?"
> "Summarize the week 6 slides in Linear Algebra."
> "What's due in the next two weeks, and what does Project 2 actually ask for?"

It works with **Claude Code, Claude Desktop, Codex (CLI and IDE), Cursor** and other apps that support local MCP servers.

> **Unofficial.** This is a student project, not made or endorsed by DTU. It only reads what your own DTU Learn account can already see.

## How it works

- **Runs on your own computer.** Your AI app starts it in the background when needed. There is no server in between.
- **You sign in yourself.** `login` opens a normal browser window with DTU's own sign-in page. Your password and MFA never pass through this tool. Only the resulting DTU Learn session is saved, in `~/.dtu-learn-mcp/`, readable only by you.
- **Read-only.** It only ever *reads* from DTU Learn. It cannot submit assignments, post, or change anything. Every tool is marked read-only.
- **Files stay local.** Files you ask about are downloaded to `~/.dtu-learn-mcp/files/` so the assistant can read them.

See [PRIVACY.md](PRIVACY.md) for details.

## Setup (about 2 minutes)

You need [Node.js](https://nodejs.org) 20 or newer, [Git](https://git-scm.com), and Google Chrome or Microsoft Edge. The tool is not on npm: `npx` runs it straight from this GitHub repo.

**1. Sign in once:**

```bash
npx -y github:frederikngh/dtu-learn-mcp login
```

A browser window opens. Sign in to DTU Learn as usual (including MFA). When the DTU Learn front page appears, the window closes and you're done.

**2. Add it to your AI app:**

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add dtu-learn --scope user -- npx -y github:frederikngh/dtu-learn-mcp
```

Or install the plugin, which also adds the `/dtu-learn:prepare-for-lecture` and `/dtu-learn:week-plan` skills:

```bash
claude plugin marketplace add frederikngh/dtu-learn-mcp
claude plugin install dtu-learn@dtu-learn
```
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Settings → Developer → Edit Config, and add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dtu-learn": { "command": "npx", "args": ["-y", "github:frederikngh/dtu-learn-mcp"] }
  }
}
```

Restart Claude Desktop.
</details>

<details>
<summary><b>Codex (CLI and IDE extension)</b></summary>

```bash
codex mcp add dtu-learn -- npx -y github:frederikngh/dtu-learn-mcp
```
</details>

<details>
<summary><b>Cursor, Windsurf, VS Code and others</b></summary>

Add a local (stdio) MCP server with command `npx` and arguments `-y github:frederikngh/dtu-learn-mcp`.
</details>

<details>
<summary><b>ChatGPT</b></summary>

The ChatGPT **desktop** app may be able to use local MCP servers depending on your version and plan; check OpenAI's current docs. chatgpt.com in the browser cannot reach a server on your computer.
</details>

**Windows:** if `npx` isn't found by your app, use `"command": "cmd", "args": ["/c", "npx", "-y", "github:frederikngh/dtu-learn-mcp"]`.

**Browser and phone apps** (claude.ai, chatgpt.com, mobile) are not supported: they run in the cloud and can't reach a server on your computer.

## Tools

| Tool | What it does |
|---|---|
| `list_courses` | Your current (or past) courses |
| `get_course_outline` | A course's modules and files, searchable ("lecture 5", "week 6") |
| `read_file` | Downloads a file and returns its text: PDF, PowerPoint (with speaker notes), Word, notebooks, code |
| `get_topic` | Details and URL for links, videos (Panopto) and external tools |
| `get_upcoming` | Deadlines and dated items in the next N days |
| `list_assignments` / `get_assignment` | Hand-ins with instructions, attachments, your submission status and feedback (feedback files can be read with `read_file`) |
| `get_announcements` | Recent course announcements |
| `status` / `login` | Check or renew your sign-in |

Courses can be named by number (`02450`) or by part of their name.

## Command line

Everything is also available from a terminal, which works with any agent that can run commands:

```bash
npx -y github:frederikngh/dtu-learn-mcp courses
npx -y github:frederikngh/dtu-learn-mcp upcoming --days 14
npx -y github:frederikngh/dtu-learn-mcp outline 02450 --search "lecture 5"
npx -y github:frederikngh/dtu-learn-mcp file 02450 123456
npx -y github:frederikngh/dtu-learn-mcp --help
```

## Troubleshooting

- **"Not signed in" / "session has expired":** run `npx -y github:frederikngh/dtu-learn-mcp login` again. The tool tries a silent renewal first, so this should be rare.
- **"Could not start a browser":** install Chrome or Edge, or run `npx playwright install chromium`.
- **"spawn git ENOENT" or similar:** install [Git](https://git-scm.com); `npx` needs it to fetch the tool from GitHub.
- **Check everything:** `npx -y github:frederikngh/dtu-learn-mcp status`.
- **Remove all saved data:** `npx -y github:frederikngh/dtu-learn-mcp logout --all`, then delete `~/.dtu-learn-mcp`.

Settings (environment variables): `DTU_LEARN_DOWNLOAD_DIR` (where files go), `DTU_LEARN_BROWSER` (`chrome`, `msedge`, …), `DTU_LEARN_URL` (another Brightspace site; untested).

## Known limitations

- Lecture and group-work **times** come from DTU's timetable, which DTU copies into the DTU Learn calendar; `get_upcoming` shows them when they are there.
- Videos, Panopto, FeedbackFruits and other external tools can't be read, only linked.
- Scanned PDFs have no text to extract; the file is still saved so a vision-capable assistant can open it.

## Development

```bash
npm install
npm test        # builds, then runs the tests against a fake Brightspace server
npm run dev     # recompile on change
```

Test your local build in Claude Code with `claude mcp add dtu-learn-dev -- node /path/to/dtu-learn-mcp/dist/cli.js`.

Code layout: `src/auth.ts` (browser sign-in), `src/client.ts` (read-only API client), `src/api.ts` (courses, content, assignments…), `src/tools.ts` (tool definitions, shared by MCP and CLI), `src/mcp.ts` (MCP over stdio), `src/extract.ts` (file text). The plugin (skills + MCP config) lives in `plugin/`.

Contributions welcome. Please keep it read-only.

## License

MIT
