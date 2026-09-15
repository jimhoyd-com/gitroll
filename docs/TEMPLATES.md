# Templates and themes

## Kinds of events

Every Roll starts with Log, Expense, Maintenance, Decision, Issue and Milestone. Add your own:

```bash
gitroll types add "Vehicle service" --field Odometer:number --field Shop:text
```

Field kinds: `text`, `longtext`, `number`, `date`, `select`, `boolean`, `url`. The definition is saved in the Roll at `.gitroll/types/vehicle-service.yaml`, so everyone who shares the Roll sees the same form. You can also edit that file by hand (see [SPEC.md](../SPEC.md)).

## Roll templates

A template is a starting point for new Rolls: kinds of events, projects, a README and a theme. It never contains events or files.

Save one from an existing Roll:

```bash
gitroll template ~/Templates/rental-property
```

Create a Roll from it, using a folder or a GitHub repository:

```bash
gitroll new "Maple Street rental" --template ~/Templates/rental-property
```

```bash
gitroll new "Maple Street rental" --template your-name/rental-template
```

For safety, only these files are copied from a template: `.gitroll/config.yaml`, `.gitroll/types/*.yaml`, `.gitroll/theme.css`, `projects/*.yaml` and `README.md`. Scripts, workflows and anything else are ignored.

## Themes

Put a `.gitroll/theme.css` file in a Roll to change how GitRoll looks for that Roll. Override any of these variables:

```css
:root {
  --bg: #fafafa;          /* page background */
  --surface: #ffffff;     /* cards and inputs */
  --text: #18181b;
  --muted: #71717a;       /* secondary text */
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
