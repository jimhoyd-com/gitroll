# GitRoll Format, version 1

A Roll is an ordinary Git repository. It must stay readable and useful without GitRoll: every file is Markdown, YAML, or an unmodified original attachment.

## Layout

```
.gitroll/config.yaml          required
.gitroll/types/<type>.yaml    optional custom event types
entries/YYYY/MM/<id>.md       one event per file
projects/<slug>.yaml          optional project metadata
attachments/<sha256><.ext>    attachment bytes, named by content hash
```

Entries never live inside project folders. An event references projects, so one event can belong to several.

`YYYY/MM` is taken from the event's `created` timestamp and never changes when the event is edited. Readers must not depend on that folder structure: any `.md` file under `entries/` is an event.

## Dates and time zones

- **Format.** Timestamps are ISO 8601. Writers record local time with its offset, for example `2026-09-15T14:30:00-07:00`, so both the author's wall-clock time and the exact instant are kept. Readers must accept:
  - `2026-09-15T14:30:00-07:00` or `2026-09-15T21:30:00Z`: an exact instant.
  - `2026-09-15T14:30` or `2026-09-15T14:30:00`: no offset, so the reader's local time.
  - `2026-09-15`: a date typed by hand, meaning noon local time, so it falls on that day in every time zone. Writers expand it to `2026-09-15T12:00:00` when they next save the event.
  - Anything else (such as `Sept 15`) is invalid, and `gitroll check` reports it.
- **Ordering** uses the instant, so events logged in different time zones sort correctly.
- **Display and filters** use the viewer's time zone. An event logged at 9:00 in New York shows as 6:00 to someone in Los Angeles, and "this month", `after:` and `before:` use the viewer's local days.
- **Folders** (`entries/YYYY/MM`) use the year and month as written in `created`, the author's local date, and never move.
- **Fields** of kind `date` in custom types hold a date (`2026-09-15`) and are shown as that calendar day, without time zone conversion.

## `.gitroll/config.yaml`

```yaml
version: 1
name: My Roll
attachments:
  max_mb: 25              # optional per-file limit for new attachments
  remove_location: true   # optional; remove GPS data from photos (default true)
ai: true                  # optional; false turns off "Ask your Roll" for everyone
```

`.gitroll/theme.css` (optional) overrides the app's style variables. See docs/TEMPLATES.md.

The author name on new events comes from each person's own GitRoll settings or `git config user.name`, never from the shared config.

## Events

An event is a Markdown file with YAML front matter. The body is free Markdown text.

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Format version, currently `1` |
| `id` | yes | Globally unique id. Writers use UUIDv7 (time-sortable). Must match the file name. |
| `type` | no | Event type id, default `log`. Lowercase letters, digits and `-`. |
| `created` | yes | ISO 8601 timestamp with offset: when the event was recorded |
| `occurred` | no | When it happened. Defaults to `created`. Same format as `created`; see [Dates and time zones](#dates-and-time-zones). |
| `author` | no | Who logged it |
| `projects` | no | List of project slugs |
| `tags` | no | List of lowercase tags |
| `attachments` | no | List of `{ hash, name, type, size }`, where `hash` is `sha256:<hex>` |
| `amount` | no | `{ value, currency }`, where currency is an ISO 4217 code |
| `data` | no | Type-specific structured fields (a mapping) |
| `source` | no | `{ adapter, id, url? }` for events created by an import. `adapter` + `id` is unique within a Roll. |

Unknown front matter keys must be preserved by writers. Unknown `data` keys must be preserved too.

### Edits and deletion

Edits rewrite the file in place (same path, same `id`), and each edit is its own commit. Deleting an event removes its file in a commit. Git history is the audit trail: previous versions are never rewritten or force-pushed away by GitRoll.

## Event types

A type is a template: a label, an icon, and optional fields stored under `data`. It never changes how an event is stored. An event whose type isn't known is still a valid event and renders as a general log.

Built-in starter types: `log`, `expense`, `decision`, `issue`, `milestone`.

The starter set is deliberately small. A type id that no definition covers is still a valid event and renders as a general log, so a Roll may use any id it likes; anything more specific belongs in `.gitroll/types/<id>.yaml`.

A custom type lives in the Roll, so its data never depends on a plugin being installed:

```yaml
# .gitroll/types/vehicle-service.yaml
label: Vehicle service
icon: 🚗
amount: expected        # none | optional | expected (whether to show the amount field)
fields:
  - key: odometer       # lowercase letters, digits, underscore
    label: Odometer
    kind: number        # text | longtext | number | date | select | boolean | url
  - key: shop
    label: Shop
    kind: text
```

Optional `defaults` prefill the form when someone picks the type. They're plain values; GitRoll never runs anything from a Roll:

```yaml
defaults:
  text: Changed the oil.
  tags: [car]
  projects: [truck]
  amount: { value: 60, currency: USD }
  data: { shop: Jiffy Lube }
```

A custom file with the same id as a built-in type overrides it.

## Attachments

Attachments are content-addressed. An event refers to an attachment only by `hash`; the file name in the event is the original, human-readable name.

In format version 1 the bytes are stored in the repository at `attachments/<sha256hex><.ext>`. Identical files are stored once. Validators check that each file's SHA-256 matches its name.

GitRoll removes GPS location data from JPEG photos before hashing and storing them (unless `remove_location` is false), so a stored photo may differ from the camera original only in that metadata.

Rolls must not contain symbolic links. Readers must not follow them, and validators report them.

Because events reference only hashes, other storage (such as Git LFS or object storage) can be added later without changing existing events. A future store would be declared in `.gitroll/config.yaml`; readers resolve a hash by looking in the repository first.

## Projects

```yaml
# projects/bathroom-remodel.yaml
name: Bathroom Remodel
description: Main bathroom, 2026
created: 2026-09-01T10:00:00-05:00
```

An event may reference a slug that has no project file; readers show the slug as the name.

## Validation

`gitroll check` reports:

- a missing or invalid `.gitroll/config.yaml`
- event files that don't parse, lack required fields, or whose file name doesn't match their `id`
- duplicate ids or duplicate `source` identities
- attachment references with no matching file, and attachment files whose content doesn't match their hash
- invalid project or type definition files
- `data` values that don't match a known type's field kinds

Validation runs locally. A Roll requires no CI.

## Reserved for later versions

These names are reserved and currently ignored, so they're preserved like any unknown key: `pinned`, `related`, `resolves`, `entities`, `status`, `encryption`.
