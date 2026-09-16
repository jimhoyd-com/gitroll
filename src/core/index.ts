// The GitRoll format in one place: the whole of what the terminal app, the
// browser app and GitRoll.com agree on.
//
// Platform-free on purpose — no Node or browser-only APIs, no filesystem, no
// network — so the same rules run wherever a Roll is read. test/core-boundary
// enforces it.

export * from "./entry.ts";
export * from "./layout.ts";
export * from "./search.ts";
export * from "./code.ts";
export * from "./conflict.ts";
export * from "./relations.ts";
export * from "./templates.ts";
export * from "./validate.ts";
export * from "./privacy.ts";
// Entries that share a file: the format GitRoll writes by default. A reader
// that only knows one-file-per-entry sees a modern Roll as empty, so the rules
// for reading a segment belong to everyone who reads a Roll.
export * from "./grouped.ts";
export * from "./segments.ts";
export * from "./storage.ts";
export * from "./tz.ts";
export * from "./ids.ts";
export {
  AuthError,
  ConflictError,
  NotFoundError,
  UserError,
  extensionFor,
  isActiveContent,
  isoDate,
  isoLocal,
  mimeFor,
  parseAmount,
  slugify,
  summarize,
  titleCase,
} from "./util.ts";
