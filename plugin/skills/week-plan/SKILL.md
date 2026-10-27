---
name: week-plan
description: Build a study plan for the coming week from the student's DTU Learn deadlines, assignments and announcements. Use when they ask what they need to do this week, what's due, or for help planning their study time.
---

# Plan the week

1. Call `get_upcoming` with `days: 7` (or the period the student asks about).
2. Call `get_announcements` with `days: 7` and pick out anything that changes plans (room changes, cancelled lectures, new deadlines, exam info).
3. For each assignment due in the period, call `get_assignment` to see the requirements and whether the student has already submitted. Skip ones already submitted unless they ask.
4. Build the plan:
   - **Deadlines first**, sorted by date, with the course, what is required (one line), and submission status.
   - **Suggested schedule:** spread the work over the days before each deadline. Put larger hand-ins earlier and leave a buffer before the deadline. For a detailed day-by-day plan, work around the lectures and group work that `get_upcoming` lists from the DTU timetable, and ask about other fixed commitments (job, sports).
   - **Heads-up:** relevant announcements, in one line each.

Keep it short and concrete. Don't invent deadlines; everything must come from the tools. If a tool reports the student isn't signed in, call `login` and tell them to finish signing in in the browser window that opens.
