# Quick Capture

A small window, over whatever you are doing, that takes one event and gets out
of the way.

```
gitroll capture
```

That command is the whole feature. A keyboard shortcut is an optional
convenience on top of it, not a requirement, and nothing here needs the browser
app or a terminal to stay open.

---

## Setting it up

### 1. Choose where captures go

Quick Capture saves into one Roll, chosen once:

```bash
gitroll new "Inbox"      # a private Roll of your own is the right home
gitroll inbox inbox      # captures now go there
gitroll inbox            # shows the current destination
```

`gitroll setup` sets this for you when it creates your first Roll.

**Use a private Roll.** A Roll that lives inside a project repository is as
visible as that repository: everyone who can read the code can read what you
capture. GitRoll will let you choose one, and then says **Shared with
repository** on every draft addressed to it — but a half-formed note at 11pm is
not something to publish to your team by accident.

The destination never moves on its own. Switching Rolls with `gitroll switch`,
or working in a different repository all day, does not change where capture
saves. Nothing about the application in front of you is inspected, either: the
destination is the one you chose, or the one you pick in the window.

### 2. Bind a key (optional)

```bash
gitroll shortcut "Ctrl+Alt+L"    # or whatever you like
gitroll shortcut                 # what is bound now
gitroll shortcut off             # remove it
```

GitRoll does not install a keyboard hook and does not run a background process
that watches your keys. Every desktop it targets already owns global shortcuts;
GitRoll writes the setting and gets out of the way. What that means in practice
differs by platform, and `gitroll shortcut` tells you which happened:

| Platform | Mechanism | Result |
| --- | --- | --- |
| **Windows** | A Start Menu shortcut with a Hotkey property | Bound. Windows only accepts `Ctrl+Alt+<key>` or `Ctrl+Shift+<key>` here; anything else is refused rather than written and silently ignored. |
| **Linux, GNOME** (also Unity, Cinnamon, Pop) | `gsettings` custom keybinding | Bound, on Wayland as well as X11 — the compositor owns the binding, so no permission is needed and nothing has to be running. |
| **Linux, other** (KDE, Xfce, sway, Hyprland…) | Your desktop's own keyboard settings | GitRoll prints the command and the key to add. It will not write another desktop's configuration file behind your back. |
| **macOS** | A Quick Action in the Services menu | GitRoll installs the action; you assign the key once in **System Settings → Keyboard → Keyboard Shortcuts → Services**. There is no supported way for an application to register a system-wide hotkey without native code or Accessibility access, and GitRoll asks for neither. |

**Conflicts.** On Windows and GNOME, GitRoll looks for shortcuts already using
those keys and names them. It never takes a key away from something else: it
tells you, and you pick again. On macOS the conflict surfaces where you assign
the key, and on other Linux desktops wherever you add it.

Whatever the desktop does, `gitroll capture` always works — including from a
launcher such as Raycast, Alfred, Albert or rofi, and from your own `.desktop`
file or window-manager config.

---

## Using it

| Key | What it does |
| --- | --- |
| `⌘Enter` (macOS) / `Ctrl+Enter` | Save and close |
| `Esc` | Put it away. **The draft is kept.** |
| `⌘K` / `Ctrl+K` | Choose the destination Roll |
| `↑` `↓`, typing, `Enter` | Search and pick in the Roll list |

The whole window works from the keyboard. There is nothing you can only reach
with a mouse.

- The text field is focused when the window opens, and takes multiple lines.
- The destination Roll is on screen the whole time, never inferred and never
  changed by GitRoll.
- Switching Rolls re-addresses the draft and changes nothing about the text.
- A save you can see: the window confirms, then closes.
- Pressing the shortcut again brings the window you already have forward. It
  never opens a second one holding a different draft.

### What happens when things go wrong

Quick Capture is built around one rule: **writing is never lost, and a save is
never claimed that did not happen.**

- The draft is on disk before any save is attempted, and is removed only when an
  event has been committed or you discard it.
- If the destination Roll has been moved, deleted or removed from your list, the
  note stays and you are asked for somewhere else. GitRoll never quietly saves
  it in a different Roll.
- If the file is written but Git refuses the commit — a pre-commit hook, a
  locked index, a full disk — you are told exactly that, the draft stays, and
  the window does not close. `gitroll save` finishes the job.
- Every attempt at one draft carries the same retry key, so a second press of
  the save keys, or a retry after an error, finds the event that already exists
  instead of writing another.
- In a Roll set to `commit: manual`, the event is written and *not* committed,
  and the window says so rather than showing a green tick.

Drafts live with your settings (`drafts/capture.json`, readable only by you),
never inside a Roll. They are never committed, synced or shared, and their text
never appears in a log line or any other output.

---

## Selecting a destination from the command line

```bash
gitroll capture --roll work      # address this capture to a named Roll
gitroll capture -C ~/src/api     # a folder, if it is a Roll on your list
gitroll capture --no-window      # print the window's address instead of opening it
```

`--roll` and `-C` follow the same rules as every other GitRoll command, and
re-address a draft that is already open without touching its text.

`gitroll capture` opens a window, so — like `gitroll`, `gitroll open` and
`gitroll setup` — it refuses `--json` and `--non-interactive` rather than
pretending to have done something a script could use. `gitroll inbox` and
`gitroll shortcut` are ordinary commands and support `--json`.

---

## Why there is no Electron app, and no tray icon

GitRoll ships as one bundled file (`dist/gitroll.mjs`) plus static web assets,
installed with npm, Homebrew or Scoop, and its release pipeline builds a single
tarball that is verified on clean Ubuntu, macOS and Windows runners. Three
options were weighed against that.

**Electron.** A tray icon, a real global shortcut API and a native window, at
the cost of roughly 100–150 MB per platform, three separate signed and notarized
binaries, a Chromium security-update treadmill, and a release pipeline that
would have to change shape entirely. For a window that holds one text field,
that is a very large bill.

**Tauri.** Much smaller binaries and the same tray and shortcut APIs, but it
needs a Rust toolchain in the build, per-platform artifacts, WebView2 on Windows
and WebKitGTK on Linux — and a distribution story that no longer fits
`npm install -g gitroll`. GitRoll's whole install today is "you already have
Node".

**What was built instead.** The capture window is the local server GitRoll
already has — loopback only, a random access key per run, an HttpOnly cookie,
the same security headers and the same strict content policy — rendered by a
Chromium-family browser in app mode, which gives a small chromeless window and,
because it runs in a profile of its own, a process GitRoll can close when the
note is saved. The global shortcut is the desktop's own. Nothing new is
downloaded, nothing is signed, nothing is resident.

The honest cost of that choice, stated plainly:

- **There is no menu-bar or system-tray entry, and no launch-at-login toggle.**
  Under this design there is nothing to keep running: the shortcut lives in the
  desktop's settings and works after a reboot, after an upgrade, and while
  GitRoll is not running at all. A resident helper would exist only to hold a
  hotkey the operating system is already holding, and would bring a login item,
  a crash surface and a second-instance problem with it. On macOS the Quick
  Action does appear in the menu bar, under Services. If a tray entry is wanted
  later for its own sake, it is an additive change: `gitroll capture` is the
  interface it would drive.
- **Without a Chromium-family browser** (Chrome, Edge, Brave, Chromium) the note
  opens in your default browser as an ordinary tab. It works; GitRoll says
  plainly that it cannot size or close that tab for you.
- **Focus is returned by closing the window**, which is what hands the keyboard
  back to whatever was in front. GitRoll does not read which application that
  was, does not ask for Accessibility access, and does not promise identical
  behaviour on every window manager.
- **Raising an existing window** is what a second press does, as far as the
  platform allows. On Wayland an application cannot raise itself, so the second
  press reaches the window where it already is; the draft and the cursor are
  where you left them.

---

## Not in this first release

Attachments, automatic project detection from the application in front of you,
and a separate shortcut per Roll. The first two were deliberately excluded:
inferring a project means inspecting other applications, which is exactly the
permission this design refuses to ask for.

---

## What was actually tested

- **Linux (x86-64, headless Chromium):** the full suite, including the capture
  window driven keyboard-only in a real browser — opening focused, multiline
  text, `Ctrl+Enter` saving, `Esc` keeping the draft, the Roll picker searched
  and chosen with the keyboard, the "Shared with repository" reminder, draft
  recovery on reopening, a failed save keeping the text, duplicate invocation,
  keyed retries producing one event, a stale window record, and rejection of
  unauthenticated and cross-origin requests. GNOME `gsettings` binding was
  exercised through the code path but not against a running GNOME session.
- **macOS and Windows:** not executed. The service, draft, save/commit,
  duplicate-invocation and shortcut-parsing logic is platform-independent and is
  covered above. The platform-specific parts that have not been run on their own
  operating system are: the Start Menu `.lnk` hotkey written through PowerShell,
  its conflict scan, and the macOS Quick Action bundle. Each reports what it did
  and falls back to printed instructions when it cannot do it, so the failure
  mode is a person following four steps rather than a shortcut that silently
  does nothing.

Known limitations are listed above rather than in a footnote: no tray entry, no
launch-at-login, app-mode window only with a Chromium-family browser, manual key
assignment on macOS and on Linux desktops other than GNOME, and no window
raising on Wayland.
