import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep tests away from the developer's real settings and git configuration.
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-test-home-"));
Object.assign(process.env, {
  GITROLL_HOME: path.join(isolated, "settings"),
  GITROLL_ROLLS: path.join(isolated, "rolls"),
  GIT_CONFIG_GLOBAL: path.join(isolated, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});
fs.writeFileSync(path.join(isolated, "gitconfig"), "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");

export const gitEnv = { ...process.env };
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-test-"));

/** An empty bare repository standing in for a new private GitHub repo. */
export function fakeGitHubRepo(): string {
  const dir = tmp();
  git(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
}

/**
 * An $EDITOR for tests, as a Node script rather than a shell one-liner.
 *
 * `sed -i` is spelled differently on GNU and BSD, so a fixture written with it
 * runs on Linux and quietly means something else on macOS — where several of
 * these tests are meant to prove that editing works. `edit` is given the file's
 * text and returns what the editor should leave behind.
 */
export function editorCommand(edit: (text: string) => string): string {
  const file = path.join(tmp(), "editor.mjs");
  fs.writeFileSync(
    file,
    `import fs from "node:fs";\nconst target = process.argv[2];\nconst edit = ${edit.toString()};\nfs.writeFileSync(target, edit(fs.readFileSync(target, "utf8")));\n`,
  );
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
}
