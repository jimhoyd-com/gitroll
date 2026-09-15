# Roadmap

GitRoll answers four questions: What happened? When did it happen? What evidence do I have? Can I find it again?

## V1: local-first (current)

Open a Roll → log an event → attach a photo or receipt → commit locally → view the timeline → search → sync to a private GitHub repository.

Includes projects, tags, timestamps, extensible event types, repository attachments with size limits, edit history, local validation, and a documented format that works without GitRoll.

## Deliberately deferred

These were considered and set aside until the local workflow is proven in daily use:

- A browser app that talks to GitHub directly, GitHub App or OAuth sign-in, and hosted GitRoll pages
- Hosted services, accounts, billing, or databases
- Git LFS, S3, R2 or other attachment stores (the format already allows them; see SPEC.md)
- Adapters beyond generic JSON import (GitHub, email, calendar, Home Assistant, OCR)
- PWA or mobile capture
- Collaboration features beyond ordinary Git sharing
- AI search ("Ask your Roll"). When built, every answer must link to the events it came from.
- Pins, related events, resolving issues, people and entities, saved searches, export and import, QR codes for assets

## Not planned

Kanban boards, sprints, Gantt charts, task management, accounting, blockchain.
