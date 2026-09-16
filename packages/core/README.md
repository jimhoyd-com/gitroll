# @gitroll/core

The GitRoll format as a library: read and write events, work out paths and names, validate a log, search, and check privacy. It has no filesystem, network or platform dependencies, so the same rules run in the local GitRoll app, in browsers and on edge runtimes such as GitRoll.com.

```ts
import { parseEntry, buildEntry, applyChanges, validateRepo, SearchIndex, templateStatus } from "@gitroll/core";

// An event is a Markdown file; its path is its identity.
const event = parseEntry(".gitroll/events/2026-09-15-ac-serviced.md", source);
event.title; // "AC serviced"
event.date;  // "2026-09-15", from the file name
event.attachments; // the files it links to
```

The format itself is specified in [SPEC.md](https://github.com/jimhoyd-com/gitroll/blob/main/SPEC.md). Version numbers follow semver: breaking changes to the API or the format are a new major version.
