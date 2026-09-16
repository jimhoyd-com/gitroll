// Binding a key to `gitroll capture`, using whatever the desktop already has.
//
// GitRoll does not install a keyboard hook. Every desktop it targets already
// owns global shortcuts and already has a supported way to say "this key runs
// this command"; using that means no background process has to watch the
// keyboard, nothing has to be trusted with input, and a shortcut keeps working
// after GitRoll is upgraded or is not running at all.
//
// What that costs is uniformity, and this file is honest about it rather than
// pretending otherwise:
//
//   Windows   A Start Menu shortcut carries a Hotkey property, which Windows
//             registers globally. GitRoll writes it. Ctrl+Alt+<key> only.
//   GNOME     Custom keybindings are a setting; GitRoll writes it with
//             gsettings. This works on Wayland as well as X11, because the
//             compositor owns the binding, not the application.
//   KDE, Xfce, Sway, others
//             The command is the same; where GitRoll cannot write the setting
//             safely it says exactly what to paste where.
//   macOS     There is no supported way to register a system-wide hotkey
//             without either native code or Accessibility access, and GitRoll
//             asks for neither. It installs a Quick Action that runs
//             `gitroll capture`, and the key is assigned once in System
//             Settings, where macOS expects it to be assigned.
//
// A shortcut nobody could set is worse than one honest sentence, so every
// return value says which of these happened.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserError } from "../core/util.ts";
import { loadUserConfig, saveUserConfig } from "./user-config.ts";

export type Modifier = "ctrl" | "alt" | "shift" | "meta";

export interface Shortcut {
  mods: Modifier[];
  /** A single character, or a named key such as F5 or Space. Upper case. */
  key: string;
}

const MOD_ALIASES: Record<string, Modifier> = {
  ctrl: "ctrl", control: "ctrl", ctl: "ctrl",
  alt: "alt", option: "alt", opt: "alt",
  shift: "shift",
  cmd: "meta", command: "meta", super: "meta", win: "meta", meta: "meta", windows: "meta",
};
const ORDER: Modifier[] = ["ctrl", "alt", "shift", "meta"];
const NAMED_KEYS = new Set(["SPACE", "ENTER", "RETURN", "TAB", "BACKSPACE", "ESCAPE", "HOME", "END", "INSERT", "DELETE", "PAGEUP", "PAGEDOWN", "UP", "DOWN", "LEFT", "RIGHT"]);

/** The key GitRoll suggests, per platform. Nothing is bound without being asked. */
export const DEFAULT_SHORTCUT = process.platform === "darwin" ? "Cmd+Shift+L" : "Ctrl+Alt+L";

export function parseShortcut(input: string): Shortcut {
  const parts = String(input).split(/[+\-]/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new UserError('Write the shortcut with its modifiers, for example: "Ctrl+Alt+L"');
  const mods = new Set<Modifier>();
  let key = "";
  for (const part of parts) {
    const mod = MOD_ALIASES[part.toLowerCase()];
    if (mod) {
      mods.add(mod);
      continue;
    }
    if (key) throw new UserError(`A shortcut has one key: "${input}" names two (${key} and ${part.toUpperCase()}).`);
    key = part.toUpperCase();
  }
  if (!key) throw new UserError(`"${input}" is only modifiers. Add the key to press, for example: Ctrl+Alt+L`);
  const named = key.replace(/\s+/g, "");
  const valid = /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key) || NAMED_KEYS.has(named);
  if (!valid) throw new UserError(`GitRoll doesn't recognise the key "${key}". Use a letter, a digit, a function key, or one of: ${[...NAMED_KEYS].join(", ")}`);
  if (!mods.size) throw new UserError(`"${input}" has no modifier, so it would capture that key everywhere. Add Ctrl, Alt, Shift or Cmd.`);
  return { mods: ORDER.filter((m) => mods.has(m)), key: NAMED_KEYS.has(named) ? named : key };
}

/** How the shortcut is written on this platform, the way its own documentation writes it. */
export function formatShortcut(shortcut: Shortcut, platform: string = process.platform): string {
  const mac: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
  const other: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: platform === "win32" ? "Win" : "Super" };
  const key = shortcut.key.length === 1 ? shortcut.key : shortcut.key.charAt(0) + shortcut.key.slice(1).toLowerCase();
  if (platform === "darwin") return shortcut.mods.map((m) => mac[m]).join("") + key;
  return [...shortcut.mods.map((m) => other[m]), key].join("+");
}

/** `planned` is a dry run: GitRoll says what it would do and changes nothing. */
export type BindStatus = "bound" | "manual" | "planned";

export interface BindResult {
  status: BindStatus;
  /** Which desktop mechanism was used, or would be. */
  mechanism: string;
  shortcut: string;
  /** What GitRoll did, in one sentence. */
  message: string;
  /** What the person still has to do, if anything. */
  steps: string[];
  /** Shortcuts already using these keys, as far as GitRoll can tell. */
  conflicts: string[];
}

/**
 * The command a shortcut runs. Absolute, because a desktop shortcut has no PATH
 * worth relying on.
 *
 * `GITROLL_BIN` overrides it whole, for somebody running GitRoll through a
 * wrapper. It is used exactly as written — it is a command line, not a path —
 * which is the point of it.
 */
export function captureCommand(): string {
  const bin = process.env.GITROLL_BIN;
  if (bin) return bin;
  // In an installed build argv[1] is dist/gitroll.mjs; from a checkout it is the
  // TypeScript entry point, which still runs under the same Node.
  const entry = process.argv[1] ?? "";
  if (entry.endsWith(".mjs") || entry.endsWith(".js")) return `${quote(process.execPath)} ${quote(entry)} capture`;
  const onPath = which("gitroll");
  if (onPath) return `${quote(onPath)} capture`;
  return `${quote(process.execPath)} ${quote(entry)} capture`;
}

/**
 * Quotes one argument of that command line, for the shell that will read it.
 *
 * This string is not run here: it is written into a macOS Quick Action that zsh
 * runs, into GNOME's `command` key, and into instructions people paste into
 * their own desktop settings. So it has to survive a shell, and the obvious
 * spellings don't. Quoting only when there is a space leaves `;` and `&` bare in
 * a path that has neither, and double quotes are not a shell's idea of literal —
 * zsh still expands `$(…)`, `${…}` and backticks inside them. A POSIX
 * single-quoted string has no escapes at all except its own delimiter, so
 * quoting unconditionally and ending the quote around each `'` is the one form
 * that means exactly what it says. Windows has its own rules, and its own
 * convention, so it keeps double quotes.
 */
const quote = (s: string): string =>
  process.platform === "win32" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`;

function which(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (dir && fs.existsSync(file)) return file;
    }
  }
  return null;
}

export function bindShortcut(input: string, opts: { command?: string; platform?: string; dryRun?: boolean } = {}): BindResult {
  const shortcut = parseShortcut(input);
  const platform = opts.platform ?? process.platform;
  const command = opts.command ?? captureCommand();
  // A dry run is a question, not a change: nothing on the desktop is touched
  // and nothing is remembered. Somebody who would rather see what GitRoll is
  // about to do to their keyboard settings before it does it should be able to.
  if (opts.dryRun) {
    return {
      status: "planned",
      mechanism: plannedMechanism(platform),
      shortcut: formatShortcut(shortcut, platform),
      message: `${formatShortcut(shortcut, platform)} would be set as a ${plannedMechanism(platform)}, running: ${command}`,
      steps: [`Nothing was changed. To do it: gitroll shortcut ${JSON.stringify(input)}`],
      conflicts: [],
    };
  }
  const result =
    platform === "win32" ? bindWindows(shortcut, command)
    : platform === "darwin" ? bindMac(shortcut, command)
    : bindLinux(shortcut, command);
  const config = loadUserConfig();
  config.captureShortcut = formatShortcut(shortcut, platform);
  saveUserConfig(config);
  return result;
}

export function unbindShortcut(opts: { platform?: string } = {}): { removed: boolean; mechanism: string; steps: string[] } {
  const platform = opts.platform ?? process.platform;
  const config = loadUserConfig();
  delete config.captureShortcut;
  saveUserConfig(config);
  if (platform === "win32") {
    const link = windowsLinkPath();
    const removed = fs.existsSync(link);
    fs.rmSync(link, { force: true });
    return { removed, mechanism: "Start Menu shortcut", steps: [] };
  }
  if (platform === "darwin") {
    const service = macServicePath();
    const removed = fs.existsSync(service);
    fs.rmSync(service, { recursive: true, force: true });
    return { removed, mechanism: "Quick Action", steps: removed ? ["The key you assigned in System Settings → Keyboard → Keyboard Shortcuts → Services is released with it."] : [] };
  }
  return { removed: removeGnomeBinding(), mechanism: "GNOME custom keybinding", steps: [] };
}

// ── Windows ────────────────────────────────────────────────────────────────
//
// A .lnk with a Hotkey is the documented way to give a command a system-wide
// key. Windows only honours Ctrl+Alt+<key> on these (and Ctrl+Shift+<key>), so
// anything else is refused here rather than written and silently ignored.

const windowsLinkPath = (): string =>
  path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "GitRoll Quick Capture.lnk");

function bindWindows(shortcut: Shortcut, command: string): BindResult {
  const accel = formatShortcut(shortcut, "win32");
  const mods = new Set(shortcut.mods);
  const supported = mods.has("ctrl") && (mods.has("alt") || mods.has("shift")) && !mods.has("meta");
  if (!supported) {
    return {
      status: "manual",
      mechanism: "Start Menu shortcut",
      shortcut: accel,
      message: `Windows only gives a Start Menu shortcut keys of the form Ctrl+Alt+<key> or Ctrl+Shift+<key>, so it can't take ${accel}.`,
      steps: [`Choose another shortcut, for example: gitroll shortcut "Ctrl+Alt+L"`],
      conflicts: [],
    };
  }
  const link = windowsLinkPath();
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const hotkey = [...(mods.has("ctrl") ? ["Ctrl"] : []), ...(mods.has("alt") ? ["Alt"] : []), ...(mods.has("shift") ? ["Shift"] : []), shortcut.key].join("+");
  const conflicts = windowsConflicts(link);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    `$link = $shell.CreateShortcut(${psString(link)})`,
    `$link.TargetPath = ${psString(process.execPath)}`,
    `$link.Arguments = ${psString(windowsArguments(command))}`,
    `$link.Description = 'Open GitRoll Quick Capture'`,
    `$link.WindowStyle = 7`,
    `$link.Hotkey = ${psString(hotkey)}`,
    "$link.Save()",
  ].join("\n");
  const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  if (run.status !== 0) {
    return {
      status: "manual",
      mechanism: "Start Menu shortcut",
      shortcut: accel,
      message: `GitRoll couldn't write the Start Menu shortcut: ${(run.stderr || run.stdout || "PowerShell was not available").trim()}`,
      steps: [`Create a shortcut to \`${command}\` yourself, open its Properties, and put ${accel} in the "Shortcut key" box.`],
      conflicts,
    };
  }
  return {
    status: "bound",
    mechanism: "Start Menu shortcut",
    shortcut: accel,
    message: `${accel} now opens Quick Capture.`,
    steps: conflicts.length ? [`Windows gives the key to whichever shortcut it finds first. Change or remove the other one if ${accel} opens the wrong thing.`] : [],
    conflicts,
  };
}

/** The .lnk runs Node directly, so there is no console window and no shell quoting to get wrong. */
function windowsArguments(command: string): string {
  const entry = process.argv[1] ?? "";
  return command === captureCommand() && entry ? `${JSON.stringify(entry)} capture` : command;
}

const psString = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Other Start Menu shortcuts already claiming a hotkey, so a clash can be named rather than guessed at. */
function windowsConflicts(ours: string): string[] {
  const dir = path.dirname(ours);
  try {
    const script = `Get-ChildItem -Path ${psString(dir)} -Filter *.lnk | ForEach-Object { $s = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName); if ($s.Hotkey) { $_.Name + ' — ' + $s.Hotkey } }`;
    const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
    return (out.stdout ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith(path.basename(ours)));
  } catch {
    return [];
  }
}

// ── macOS ──────────────────────────────────────────────────────────────────
//
// A Quick Action is a real, supported, permission-free way to put a command in
// the Services menu, where the keyboard settings can give it a key. GitRoll
// writes the action; the key is assigned once, by hand, because macOS provides
// no interface for an application to assign one.

const macServicePath = (): string => path.join(os.homedir(), "Library", "Services", "GitRoll Quick Capture.workflow");

function bindMac(shortcut: Shortcut, command: string): BindResult {
  const accel = formatShortcut(shortcut, "darwin");
  const dir = path.join(macServicePath(), "Contents");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Info.plist"), macInfoPlist());
    fs.writeFileSync(path.join(dir, "document.wflow"), macWorkflow(command));
  } catch (e) {
    return {
      status: "manual",
      mechanism: "Quick Action",
      shortcut: accel,
      message: `GitRoll couldn't install the Quick Action: ${(e as Error).message}`,
      steps: [`Bind \`${command}\` to ${accel} with your own launcher (Raycast, Alfred, Keyboard Maestro and skhd all do this).`],
      conflicts: [],
    };
  }
  return {
    status: "manual",
    mechanism: "Quick Action",
    shortcut: accel,
    message: "GitRoll installed a “GitRoll Quick Capture” Quick Action. macOS doesn't let an app assign a system shortcut, so the key is yours to set — once.",
    steps: [
      "Open System Settings → Keyboard → Keyboard Shortcuts → Services.",
      "Find “GitRoll Quick Capture” under General.",
      `Click "none", press ${accel}, and close the window.`,
      "If macOS says the key is already used, pick another and run this command again with it.",
    ],
    conflicts: [],
  };
}

const macInfoPlist = (): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict><key>default</key><string>GitRoll Quick Capture</string></dict>
      <key>NSMessage</key><string>runWorkflowAsService</string>
      <key>NSSendTypes</key><array/>
      <key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string></string></dict>
    </dict>
  </array>
</dict>
</plist>
`;

const macWorkflow = (command: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key><string>523</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key><string>${xml(command)}</string>
          <key>CheckedForUserDefaultShell</key><true/>
          <key>inputMethod</key><integer>0</integer>
          <key>shell</key><string>/bin/zsh</string>
          <key>source</key><string></string>
        </dict>
        <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>InputUUID</key><string>C2F0F1B0-0001-4000-A000-000000000001</string>
        <key>OutputUUID</key><string>C2F0F1B0-0002-4000-A000-000000000002</string>
        <key>UUID</key><string>C2F0F1B0-0003-4000-A000-000000000003</string>
      </dict>
    </dict>
  </array>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceInputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceApplicationBundleID</key><string></string>
    <key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
`;

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Linux ──────────────────────────────────────────────────────────────────

const GNOME_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys";
const GNOME_PATH = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/gitroll-capture/";

/** How GNOME writes a shortcut: `<Control><Alt>l`, and named keys in angle-free form. */
export function gnomeAccelerator(shortcut: Shortcut): string {
  const names: Record<Modifier, string> = { ctrl: "<Control>", alt: "<Alt>", shift: "<Shift>", meta: "<Super>" };
  const key = shortcut.key.length === 1 ? shortcut.key.toLowerCase() : shortcut.key.charAt(0) + shortcut.key.slice(1).toLowerCase();
  return shortcut.mods.map((m) => names[m]).join("") + key;
}

/**
 * sway and i3 read the key literally, so an upper-case letter means the shifted
 * one: `bindsym Ctrl+Alt+L` is Ctrl+Alt+Shift+l, which is not what was asked
 * for. Everything else in their syntax GitRoll already writes the same way.
 */
export const swayBinding = (shortcut: Shortcut): string =>
  [...shortcut.mods.map((m) => swayMod[m]), swayKey(shortcut.key)].join("+");

/** X keysym names, which is what sway and i3 expect rather than GitRoll's own spelling. */
const SWAY_KEYSYMS: Record<string, string> = {
  SPACE: "space", ENTER: "Return", RETURN: "Return", TAB: "Tab", BACKSPACE: "BackSpace", ESCAPE: "Escape",
  HOME: "Home", END: "End", INSERT: "Insert", DELETE: "Delete", PAGEUP: "Prior", PAGEDOWN: "Next",
  UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right",
};
const swayKey = (key: string): string => SWAY_KEYSYMS[key] ?? (key.length === 1 ? key.toLowerCase() : key);

const swayMod: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Mod1", shift: "Shift", meta: "Mod4" };
const hyprMod: Record<Modifier, string> = { ctrl: "CTRL", alt: "ALT", shift: "SHIFT", meta: "SUPER" };

const desktop = (): string => (process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION ?? "").toLowerCase();
const onWayland = (): boolean => (process.env.XDG_SESSION_TYPE ?? "").toLowerCase() === "wayland";

function gsettings(args: string[]): string | null {
  try {
    return execFileSync("gsettings", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function bindLinux(shortcut: Shortcut, command: string): BindResult {
  const accel = formatShortcut(shortcut, "linux");
  const gnomeish = /gnome|unity|cinnamon|pop/.test(desktop());
  const waylandNote = onWayland()
    ? "On Wayland the compositor owns global shortcuts, so this is set in your desktop's settings rather than by GitRoll watching the keyboard — and GitRoll cannot raise an existing window for you there; the second press reaches the window it is already in."
    : "";
  if (gnomeish && gsettings(["get", GNOME_SCHEMA, "custom-keybindings"]) !== null) {
    const conflicts = gnomeConflicts(gnomeAccelerator(shortcut));
    const written = writeGnomeBinding(shortcut, command);
    if (written) {
      return {
        status: "bound",
        mechanism: "GNOME custom keybinding",
        shortcut: accel,
        message: `${accel} now opens Quick Capture.`,
        steps: [waylandNote, ...(conflicts.length ? [`${accel} is also used by: ${conflicts.join(", ")}. Change one of them, or pick another key.`] : [])].filter(Boolean),
        conflicts,
      };
    }
  }
  const where = gnomeish ? "your desktop's keyboard settings" : desktop() ? `${desktop()}'s keyboard settings` : "your desktop's keyboard settings";
  return {
    status: "manual",
    mechanism: "desktop keyboard settings",
    shortcut: accel,
    message: `GitRoll can't write ${where} safely, so the shortcut is yours to add — once.`,
    steps: [
      `Open ${where} and add a custom shortcut.`,
      `Command: ${command}`,
      `Key: ${accel}`,
      ...(desktop().includes("kde") ? ["In KDE this is System Settings → Keyboard → Shortcuts → Add New → Command or Script."] : []),
      ...(desktop().includes("sway") || desktop().includes("i3") ? [`In sway or i3, add it to your config: bindsym ${swayBinding(shortcut)} exec ${command}`] : []),
      ...(desktop().includes("hypr") ? [`In Hyprland, add it to your config: bind = ${shortcut.mods.map((m) => hyprMod[m]).join(" ")}, ${shortcut.key}, exec, ${command}`] : []),
      waylandNote,
    ].filter(Boolean),
    conflicts: [],
  };
}

function writeGnomeBinding(shortcut: Shortcut, command: string): boolean {
  const listRaw = gsettings(["get", GNOME_SCHEMA, "custom-keybindings"]);
  if (listRaw === null) return false;
  const existing = [...listRaw.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p !== GNOME_PATH);
  const list = `[${[...existing, GNOME_PATH].map((p) => `'${p}'`).join(", ")}]`;
  const set = (key: string, value: string) =>
    gsettings(["set", `${GNOME_SCHEMA}.custom-keybinding:${GNOME_PATH}`, key, value]) !== null;
  const ok = set("name", "GitRoll Quick Capture") && set("command", command) && set("binding", gnomeAccelerator(shortcut));
  if (!ok) return false;
  return gsettings(["set", GNOME_SCHEMA, "custom-keybindings", list]) !== null;
}

function removeGnomeBinding(): boolean {
  const listRaw = gsettings(["get", GNOME_SCHEMA, "custom-keybindings"]);
  if (listRaw === null) return false;
  const existing = [...listRaw.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (!existing.includes(GNOME_PATH)) return false;
  const rest = existing.filter((p) => p !== GNOME_PATH);
  gsettings(["set", GNOME_SCHEMA, "custom-keybindings", rest.length ? `[${rest.map((p) => `'${p}'`).join(", ")}]` : "[]"]);
  return true;
}

/** Shortcuts GNOME already has on these keys. Reported, never overwritten. */
function gnomeConflicts(accel: string): string[] {
  const found: string[] = [];
  for (const schema of ["org.gnome.desktop.wm.keybindings", GNOME_SCHEMA, "org.gnome.shell.keybindings"]) {
    const listed = gsettings(["list-recursively", schema]);
    if (!listed) continue;
    for (const line of listed.split("\n")) {
      if (!line.includes(`'${accel}'`)) continue;
      const name = line.split(/\s+/)[1];
      if (name) found.push(`${schema} ${name}`);
    }
  }
  const custom = gsettings(["get", GNOME_SCHEMA, "custom-keybindings"]);
  for (const p of [...(custom ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1])) {
    if (p === GNOME_PATH) continue;
    const binding = gsettings(["get", `${GNOME_SCHEMA}.custom-keybinding:${p}`, "binding"])?.trim();
    if (binding === `'${accel}'`) found.push(gsettings(["get", `${GNOME_SCHEMA}.custom-keybinding:${p}`, "name"])?.trim().replace(/^'|'$/g, "") ?? p);
  }
  return [...new Set(found)];
}

const plannedMechanism = (platform: string): string =>
  platform === "win32" ? "Start Menu shortcut" : platform === "darwin" ? "Quick Action" : /gnome|unity|cinnamon|pop/.test(desktop()) ? "GNOME custom keybinding" : "desktop keyboard settings entry";

/** What is bound now, as far as this computer will say. */
export function shortcutStatus(): { shortcut: string | null; mechanism: string; installed: boolean; command: string } {
  const config = loadUserConfig();
  const mechanism =
    process.platform === "win32" ? "Start Menu shortcut" : process.platform === "darwin" ? "Quick Action" : "GNOME custom keybinding";
  const installed =
    process.platform === "win32" ? fs.existsSync(windowsLinkPath())
    : process.platform === "darwin" ? fs.existsSync(macServicePath())
    : (gsettings(["get", GNOME_SCHEMA, "custom-keybindings"]) ?? "").includes(GNOME_PATH);
  return { shortcut: config.captureShortcut ?? null, mechanism, installed, command: captureCommand() };
}
