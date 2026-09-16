// Publishes template/ to the Roll template repository, so people can start a Roll
// with GitHub's "Use this template" instead of `gitroll setup`.
//
//   node scripts/publish-template.mjs --out <folder>           build only (for testing)
//   node scripts/publish-template.mjs --template <folder>      read the starter files elsewhere
//   node scripts/publish-template.mjs [--repo owner/name]      build, commit and push
//
// template/ in this repository is the only source of the starter files; the template
// repository is generated from it and never edited by hand. Only Roll data is allowed:
// no code, scripts or workflows can end up in someone's Roll.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { repo: { type: "string" }, out: { type: "string" }, template: { type: "string" } } });
const repo = values.repo ?? "jimhoyd-com/gitroll-template";
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const ALLOWED = [
  /^\.gitroll\/config\.yaml$/,
  /^\.gitroll\/README\.md$/,
  /^\.gitroll\/theme\.css$/,
  /^\.gitroll\/events\/\.gitkeep$/,
  /^\.gitroll\/\.gitattributes$/,
  /^\.gitroll\/\.gitignore$/,
  /^README\.md$/,
];

// Only a test points this anywhere else, so that refusing a file that isn't Roll
// data can be shown to be a refusal rather than a silent skip.
const templateDir = values.template ? path.resolve(values.template) : path.join(root, "template");

function templateFiles() {
  const dir = templateDir;
  const files = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) throw new Error(`template/${child} is a symbolic link; templates may only contain plain files`);
      if (d.isDirectory()) walk(child);
      else if (d.isFile()) files.push(child);
    }
  };
  walk("");
  const refused = files.filter((f) => !ALLOWED.some((re) => re.test(f)));
  if (refused.length) throw new Error(`Refusing to publish non-Roll files: ${refused.join(", ")}`);
  return files;
}

const README_FOOTER = `
---

## Using this template

This repository is the starting point for a **Roll**: a log kept as ordinary Markdown files in Git. Everything GitRoll knows about lives in [\`.gitroll/\`](.gitroll), and that folder is committed like the rest of the repository.

You do not need [GitRoll](https://github.com/jimhoyd-com/gitroll) to use it. Git and a text editor are enough; [\`.gitroll/README.md\`](.gitroll/README.md) is the whole format. GitRoll is an optional app that reads and writes the same files.

1. **Create your repository from this template.** Click **Use this template → Create a new repository**, pick the owner and a name, and choose **Private** if what you log is private.
2. **Clone it** to your computer:

   \`\`\`bash
   git clone git@github.com:YOU/YOUR-ROLL.git
   \`\`\`

3. **Log something.** Create \`.gitroll/events/2026-09-15-ac-serviced.md\`, write what happened, then:

   \`\`\`bash
   git add .gitroll
   git commit -m "AC serviced"
   git push
   \`\`\`

4. **Optionally, open it with GitRoll:**

   \`\`\`bash
   cd YOUR-ROLL
   gitroll
   \`\`\`

   GitRoll checks the files, adds the Roll to your list, and opens it. Use ↑↓ to browse, \`n\` to log, \`/\` to find, \`s\` to sync and \`o\` to open it in your browser. \`gitroll rolls add .\` adds it without opening.

### Good to know

- **The log is as visible as the repository.** \`.gitroll/\` is a namespace, not a privacy boundary: in a public repository, every event and every file in it is public. GitRoll refuses to sync a Roll to a public repository.
- **\`.gitroll/config.yaml\` records the template version** this repository follows. GitRoll reads it, and never changes it while logging or editing.
- **Already have a project?** You don't need this template. Run \`gitroll\` inside that repository and choose *Add a log to this repository*: only \`.gitroll/\` is created, and nothing else is touched.
- **Upgrades don't touch your log.** New GitRoll versions read the same files. Upgrade the app with \`gitroll upgrade\`.
- **No GitHub Actions are needed.** Logging and syncing use none of your Actions minutes.
- **Questions or problems?** Open an issue on [jimhoyd-com/gitroll](https://github.com/jimhoyd-com/gitroll/issues). This repository is generated from [\`template/\`](https://github.com/jimhoyd-com/gitroll/tree/main/template) there on each release, so please don't open pull requests here.
`;

function build(target) {
  for (const entry of fs.readdirSync(target)) if (entry !== ".git") fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  for (const rel of templateFiles()) {
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let content = fs.readFileSync(path.join(templateDir, rel));
    if (rel === "README.md") content = Buffer.from(`${content.toString("utf8").trimEnd()}\n${README_FOOTER}`);
    fs.writeFileSync(dest, content);
  }
  // Validate with GitRoll's own checker before anything is published.
  const out = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(root, "src/node/cli.ts"), "check", "-C", target], {
    encoding: "utf8",
    env: { ...process.env, GITROLL_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-template-home-")) },
  });
  if (!/looks good/.test(out)) throw new Error(`The template doesn't validate:\n${out}`);
}

if (values.out) {
  const target = path.resolve(values.out);
  fs.mkdirSync(target, { recursive: true });
  build(target);
  console.log(`Built the template in ${target}`);
  process.exit(0);
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "gitroll-template-"));
const token = process.env.TEMPLATE_REPO_TOKEN;
const url = token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
try {
  try {
    git(work, "clone", "-q", url, "repo");
  } catch (e) {
    throw new Error(`Couldn't clone ${repo}. Does it exist, and can these credentials push to it?\n${String(e.stderr ?? "").replaceAll(token ?? "\0", "***")}`);
  }
  const target = path.join(work, "repo");
  build(target);
  git(target, "add", "-A");
  if (!git(target, "status", "--porcelain").trim()) {
    console.log(`${repo} is already up to date with GitRoll ${version}.`);
  } else {
    git(target, "-c", "user.name=GitRoll release", "-c", "user.email=releases@users.noreply.github.com", "commit", "-q", "-m", `Starter files from GitRoll ${version}`);
    git(target, "push", "-q", "origin", "HEAD:main");
    console.log(`Published the template from GitRoll ${version} to ${repo}.`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
