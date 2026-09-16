// Starting points for the kinds of event developers write often. A template is
// only text: it fills the editor with headings worth answering, and everything
// it produces is an ordinary Markdown event. Nothing reads these back — an
// event written from a template is indistinguishable from one typed by hand,
// and deleting a heading you don't need costs nothing.

export interface EntryTemplate {
  id: string;
  label: string;
  description: string;
  /** Suggested tags, written into the front matter so the events are easy to find later. */
  tags: string[];
  /** The Markdown the editor opens with. `{{title}}` is replaced by what the person typed, if anything. */
  body: string;
  /**
   * Fields this kind of entry usually carries, so the composer offers them
   * rather than showing every field to everybody. Only `amount` so far.
   */
  fields?: ("amount")[];
}

const t = (id: string, label: string, description: string, tags: string[], body: string): EntryTemplate => ({
  id,
  label,
  description,
  tags,
  body: body.trim(),
});

export const TEMPLATES: EntryTemplate[] = [
  t(
    "debugging",
    "Debugging session",
    "What broke, what you tried, and what it turned out to be.",
    ["debugging"],
    `
# {{title}}

## Symptom

<!-- What you saw. Paste the error, the failing request, the wrong number. -->

## What I tried

<!-- One line each, including the things that didn't work: they're why the next
     person stops trying them. -->

-

## Cause

<!-- What it actually was. -->

## Fix

<!-- The change, and a reference to it: a commit SHA, #412, or owner/repo#412. -->
`,
  ),
  t(
    "incident",
    "Incident",
    "What happened, how long it lasted, what fixed it, and what to change.",
    ["incident"],
    `
# {{title}}

## Impact

<!-- Who or what was affected, and for how long. Times in UTC or with an offset. -->

- Detected:
- Mitigated:
- Resolved:

## What happened

## Why it happened

## What we did

## Follow-up

<!-- Each item worth doing, with an owner. Link the issues you filed: #412 -->

-
`,
  ),
  t(
    "deployment",
    "Deployment",
    "What went out, where, and how it went.",
    ["deployment"],
    `
# {{title}}

- Environment:
- Version or tag:
- Commit:

## What changed

<!-- The user-visible part, not the diff: Git already has the diff. -->

## How it went

<!-- Smooth, rolled back, needed a fix forward — and anything to watch. -->
`,
  ),
  t(
    "experiment",
    "Experiment",
    "The question, what you did, and what it showed.",
    ["experiment"],
    `
# {{title}}

## Question

<!-- What you wanted to find out, and what you expected. -->

## Setup

<!-- Enough that you could run it again: versions, data, machine, commands. -->

## Result

<!-- Numbers, output, or a screenshot in ../files/. -->

## What it means

<!-- Including "nothing yet" — a result you can't explain is worth recording. -->
`,
  ),
  t(
    "decision",
    "Architecture decision",
    "The decision, the alternatives, and why. An ADR in the log.",
    ["decision", "adr"],
    `
# {{title}}

- Status: proposed
- Deciders:

## Context

<!-- The forces at play: the constraint, the deadline, the thing that broke. -->

## Decision

<!-- What we are doing, in one or two sentences, in the present tense. -->

## Alternatives

<!-- What else was on the table, and why it lost. The value of an ADR is here. -->

-

## Consequences

<!-- What this makes easy, and what it makes hard or expensive to change later. -->
`,
  ),
];

export const templateIds = (): string[] => TEMPLATES.map((x) => x.id);

export function findTemplate(id: string): EntryTemplate | null {
  const key = (id ?? "").trim().toLowerCase();
  return TEMPLATES.find((x) => x.id === key) ?? (key === "adr" ? (TEMPLATES.find((x) => x.id === "decision") ?? null) : null);
}

/** The template's text with the title filled in, ready to hand to an editor. */
export function renderTemplate(template: EntryTemplate, title: string): string {
  const heading = title.trim() || template.label;
  return `${template.body.replace(/\{\{title\}\}/g, heading)}\n`;
}
