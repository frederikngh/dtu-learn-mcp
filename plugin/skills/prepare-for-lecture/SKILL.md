---
name: prepare-for-lecture
description: Prepare the student for an upcoming DTU lecture or exercise session using their DTU Learn course material. Use when they ask what to read or prepare before a lecture, want a summary of the slides for a given week, or ask "what's next in <course>".
---

# Prepare for a lecture

Use the `dtu-learn` tools to find and read the material for one lecture, then give the student a short, practical preparation brief.

## Steps

1. **Identify the course.** If the student named a course number (e.g. 02450) or name, use it. If not, call `list_courses` and ask which course, unless only one is plausible.
2. **Find the lecture.** Call `get_course_outline` for the course.
   - If they named a lecture or week ("lecture 5", "week 6"), call it again with `search` set to that text.
   - A found module's page text is shown under its title. At DTU it often lists the reading (e.g. book sections), the exercises and the hand-in for that week: use it, and treat it as the authority on what to prepare.
   - If they said "next lecture", look for the first module whose start date is today or later, or the module after the most recent one with unread items. Check `get_upcoming` for that course too. Say which lecture you picked and why.
3. **Read the material.** For each relevant file topic (slides, notes, exercise sheets, reading lists), call `read_file` with its topicId. Files linked from a module's page text (exercise sheets, answers) are read with `read_file` and `url` set to the link. Prefer slides and exercise sheets first. Page through long files with `offset` only as far as needed.
   - Links, videos (e.g. Panopto) and external tools cannot be read; list them with their URL from `get_topic` so the student can open them.
4. **Check for related deadlines** with `get_upcoming` for that course (14 days) and mention anything due around the lecture.

## The brief

Keep it to about one screen:

- **Lecture:** title, date if known, and which DTU Learn items it is based on.
- **Key ideas:** 4–8 bullets in plain language, with the formulas or definitions the slides lean on.
- **Before the lecture:** concrete reading (chapter/pages) and exercises, as stated in the material. Don't invent readings that aren't in the material.
- **Questions to think about:** 2–3 questions that test understanding of the key ideas.
- **Also due:** related deadlines.

Cite which file each point comes from (e.g. "Lecture 5 slides, slide 12"). If the material for that lecture isn't on DTU Learn yet, say so instead of guessing.
