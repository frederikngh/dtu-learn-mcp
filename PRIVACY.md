# Privacy

**Short version:** everything happens on your own computer. Nothing is sent to the author of this tool or to any server other than DTU Learn itself.

## What is stored, and where

All data lives in `~/.dtu-learn-mcp/` on your computer:

| What | Where | Why |
|---|---|---|
| Your DTU Learn session cookies and the page's CSRF token | `session.json` (readable only by your user account) | So the tool can read DTU Learn as you without asking you to sign in every time |
| A separate browser profile | `browser-profile/` | So an expired DTU Learn session can often be renewed without a new MFA prompt. It contains the cookies from your DTU sign-in, like any browser profile would |
| Files you asked the assistant to read | `files/` (or `DTU_LEARN_DOWNLOAD_DIR`) | So the text can be extracted and the original can be opened |

Your **password is never seen or stored**: you type it into DTU's own sign-in page in a normal browser window.

Treat `~/.dtu-learn-mcp/` like a logged-in browser: anyone who can read it can access your DTU Learn account until the session expires. To remove everything, run `npx -y github:frederikngh/dtu-learn-mcp logout --all` and delete the folder.

## What is sent where

- **To DTU Learn (learn.inside.dtu.dk):** read-only API requests for your courses, content, assignments, calendar and announcements, authenticated as you. The tool sends no write requests to the API. The only non-GET request is to Brightspace's own token endpoint, to turn your session into a short-lived access token, exactly as the DTU Learn website itself does.
- **To your AI app:** the text the tools return (course lists, outlines, file contents, …) goes to whichever AI app you connected the tool to, and from there to that app's AI provider, under that provider's terms. Only ask about material you're comfortable sharing with that provider, and respect your course's rules about course material.
- **To the author of this tool:** nothing. There is no telemetry or analytics.

## Contact

Open an issue at https://github.com/frederikngh/dtu-learn-mcp/issues.
