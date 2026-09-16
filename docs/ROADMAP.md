# Roadmap

GitRoll answers four questions: What happened? When did it happen? What evidence do I have? Can I find it again?

## V1: local-first (current)

Open a log → write an event → attach a photo or receipt → commit locally → view the timeline → search → sync to a private GitHub repository. A log is a `.gitroll/` folder in a repository of its own or in a project you already have.

Includes projects, tags, dates, amounts, ordinary files with readable names, edit history, local validation, and a format so small that Git and a text editor are enough: an event is a Markdown file, and front matter is optional.

## Deliberately deferred

These were considered and set aside until the local workflow is proven in daily use:

- A browser app that talks to GitHub directly, GitHub App or OAuth sign-in, and hosted GitRoll pages
- Hosted services, accounts, billing, or databases
- Git LFS, S3, R2 or other attachment stores
- Adapters beyond generic JSON import (GitHub, email, calendar, Home Assistant, OCR)
- PWA or mobile capture
- Collaboration features beyond ordinary Git sharing
- AI search ("Ask your Roll"). When built, every answer must link to the events it came from.
- Pins, related events, resolving issues, people and entities, saved searches, export and import, QR codes for assets

## Not planned

Kanban boards, sprints, Gantt charts, task management, accounting, blockchain.
