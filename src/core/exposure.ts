// What a Roll is visible to, said once, in one place — so the CLI, the app and
// the documentation cannot describe it differently.
//
// A Roll is ordinary files in an ordinary Git repository. That is the whole
// point of the format, and it is also the thing people most often get wrong:
// `.gitroll/` is a namespace, not a privacy boundary. The recommended setup is
// therefore a repository of its own, kept private. Storing a Roll inside a
// project you already have is supported and always will be — it is just a
// choice somebody should make knowingly, once, rather than be warned about on
// every save.

export const RECOMMENDED_SETUP =
  "Recommended: use a dedicated private repository. Keep your notes and attachments separate from your code.";

export const EMBEDDED_ALTERNATIVE =
  "You can also store a Roll inside an existing project, but its contents share that repository's visibility " +
  "and can be uploaded by a normal Git push. Avoid recording personal or sensitive information there.";

/** The specific things people are surprised by, in the order they tend to matter. */
export const EXPOSURE_FACTS = [
  "Notes and attachments inherit the repository's visibility and access permissions.",
  "In a public repository, committed and pushed notes are public.",
  "In a private repository, anyone with access to the repository can read them.",
  "An ordinary `git push` can upload tracked GitRoll files, whatever GitRoll's own sync checks would have said.",
  "Changing the repository's visibility later can expose records that were private when you wrote them.",
  "Deleting a file, or adding it to .gitignore, does not remove what is already in the history.",
];

/** The one-screen warning shown before a Roll is added to a repository that holds something else. */
export const embeddedWarning = (): string =>
  [`${RECOMMENDED_SETUP}`, "", "You're adding a Roll to a repository that already holds a project:", ...EXPOSURE_FACTS.map((f) => `  • ${f}`)].join("\n");

/** Files GitRoll keeps out of Git in every configuration: caches, indexes, locks, temporaries. */
export const UNTRACKED_PATTERNS = ["*.gitroll-tmp", ".gitroll-write.lock", "index.json", ".DS_Store"];
