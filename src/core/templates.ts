// Starting points for the kinds of event people write often. A template is only
// text: it fills the editor with headings worth answering, and everything it
// produces is an ordinary Markdown event. Nothing reads these back — an event
// written from a template is indistinguishable from one typed by hand, and
// deleting a heading you don't need costs nothing.
//
// They come in two groups. The developer ones are for work that happens in a
// repository; the everyday ones are for the rest of what a logbook is for, and
// they exist because a Roll is not only for people who write software. Nothing
// stops anybody using either: the group decides what is listed first, not what
// anyone is allowed to write.

export type TemplateGroup = "developer" | "everyday";

export interface EntryTemplate {
  id: string;
  label: string;
  description: string;
  /** Which list this belongs in. Ten starting points in one flat menu is worse than five. */
  group: TemplateGroup;
  /** Other names for it, for people who reach for a different word. */
  aliases: string[];
  /** Suggested tags, written into the front matter so the events are easy to find later. */
  tags: string[];
  /** The Markdown the editor opens with. `{{title}}` is replaced by what the person typed, if anything. */
  body: string;
}

const make =
  (group: TemplateGroup) =>
  (id: string, label: string, description: string, tags: string[], body: string, aliases: string[] = []): EntryTemplate => ({
    id,
    label,
    description,
    group,
    aliases,
    tags,
    body: body.trim(),
  });

const t = make("developer");
const everyday = make("everyday");

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
    ["adr"],
  ),

  // ── Everyday ─────────────────────────────────────────────────────────────

  everyday(
    "progress",
    "Project progress",
    "What moved, what's next, and what's in the way.",
    ["progress"],
    `
# {{title}}

## What moved

<!-- What is further along than it was. One line each is plenty. -->

-

## Next

<!-- The next thing you'd pick up. Write it so it makes sense on a bad Monday. -->

-

## In the way

<!-- What's blocking, and who or what would unblock it. Delete if nothing is. -->
`,
    ["project"],
  ),
  everyday(
    "learning",
    "Learning note",
    "What you were learning, what clicked, and what to come back to.",
    ["learning"],
    `
# {{title}}

## What I was working through

<!-- The chapter, the course, the problem, the documentation. Link it. -->

## What clicked

<!-- In your own words, which is the part worth having in six months. -->

## Still fuzzy

<!-- What to come back to. A question here is worth more than a tidy summary. -->
`,
    ["study", "notes"],
  ),
  everyday(
    "journal",
    "Journal",
    "What happened today, and how it went.",
    ["journal"],
    `
# {{title}}

<!-- Whatever you want to remember about today. There is no shape to fill in:
     the heading above is the day, and the rest is yours. -->
`,
    ["diary"],
  ),
  everyday(
    "maintenance",
    "Household maintenance",
    "What was done, to what, by whom, and when it's due again.",
    ["maintenance"],
    `
# {{title}}

- What it was done to:
- Who did it:
- Cost:
- Due again:

## What was done

<!-- Parts, settings, model numbers — the things you will not remember and will
     want when it happens again. -->

## Worth knowing next time

<!-- Where the shut-off valve is. That the filter is a 16x25x1. Anything that
     made it harder than it needed to be. -->
`,
    ["repair", "service"],
  ),
  everyday(
    "purchase",
    "Purchase",
    "What you bought, what it cost, and where the receipt is.",
    ["purchase"],
    `
# {{title}}

- Cost:
- Bought from:
- Serial or model:
- Warranty until:

## Why this one

<!-- What you compared it against. This is the part you'll want when it dies and
     you're deciding whether to buy the same thing again. -->

## Receipt

<!-- Drag the receipt into the composer, or put the file in ../files/ and link
     it: [Receipt](../files/receipt.pdf) -->
`,
    ["bought", "expense"],
  ),
];

export const templateIds = (): string[] => TEMPLATES.map((x) => x.id);

/** The templates in one group, in the order they are listed. */
export const templatesIn = (group: TemplateGroup): EntryTemplate[] => TEMPLATES.filter((x) => x.group === group);

export function findTemplate(id: string): EntryTemplate | null {
  const key = (id ?? "").trim().toLowerCase();
  return TEMPLATES.find((x) => x.id === key) ?? TEMPLATES.find((x) => x.aliases.includes(key)) ?? null;
}

/** The template's text with the title filled in, ready to hand to an editor. */
export function renderTemplate(template: EntryTemplate, title: string): string {
  const heading = title.trim() || template.label;
  return `${template.body.replace(/\{\{title\}\}/g, heading)}\n`;
}
