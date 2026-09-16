# Templates and themes

## Kinds of events

There aren't any. An event is a Markdown file; what kind of thing it is, is whatever you wrote in it. Use tags for the ones you want to filter on:

```markdown
---
tags: [vehicle-service]
odometer: 42000
---

# Oil change at Jiffy

Changed the oil and the filter.
```

`odometer` is a key GitRoll knows nothing about, and that is fine: it is kept as written, shown on the event, and searchable as `odometer:42000`. Nothing has to be defined anywhere first, and no definition file has to exist for the event to make sense in five years.

## Roll templates

A template is a starting point for new Rolls: a README, a theme and the template marker. It never contains events or files.

Create a Roll from one, using a folder or a GitHub repository:

```bash
gitroll new "Maple Street rental" --template ~/Templates/rental-property
```

```bash
gitroll new "Maple Street rental" --template your-name/rental-template
```

For safety, only these files are copied from a template: `.gitroll/config.yaml`, `.gitroll/README.md`, `.gitroll/theme.css`, `.gitroll/.gitattributes` and `README.md`. Scripts, workflows and anything else are ignored.

Every release also publishes the starter files to [jimhoyd-com/gitroll-template](https://github.com/jimhoyd-com/gitroll-template), for starting a Roll from GitHub's **Use this template** without installing anything.

## Themes

Put a `.gitroll/theme.css` file in a Roll to change how GitRoll looks for that Roll. Override any of these variables:

```css
:root {
  --bg: #fafafa;          /* page background */
  --surface: #ffffff;     /* cards and inputs */
  --text: #18181b;
  --muted: #52525b;       /* secondary text */
  --line: #e4e4e7;        /* borders */
  --hover: #f4f4f5;
  --accent: #18181b;      /* main buttons and selected chips */
  --accent-text: #ffffff;
  --link: #2563eb;
  --radius: 10px;
  --font: ui-sans-serif, system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #09090b; --surface: #18181b; --text: #fafafa; --accent: #fafafa; --accent-text: #18181b; }
}
```

The theme can only change styles. GitRoll's security policy blocks scripts and anything loaded from other websites.
