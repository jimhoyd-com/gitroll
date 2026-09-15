# @gitroll/core

The GitRoll Format as a library: parse and write events, validate a Roll, apply event types, search, and check privacy. It has no filesystem, network or platform dependencies, so the same rules run in the local GitRoll app, in browsers and on edge runtimes such as GitRoll.com.

```ts
import { parseEntry, serializeEntry, buildEntry, validateRepo, SearchIndex } from "@gitroll/core";
```

The format itself is specified in [SPEC.md](https://github.com/jimhoyd-com/gitroll/blob/main/SPEC.md). Version numbers follow semver: breaking changes to the API or the format are a new major version.
