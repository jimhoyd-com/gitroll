import {
  AlarmClock,
  Bookmark,
  Building2,
  CircleAlert,
  GitMerge,
  Hash,
  House,
  Link2,
  Keyboard,
  ListTodo,
  MapPin,
  NotebookPen,
  NotebookText,
  Package,
  Paperclip,
  Plus,
  Rows3,
  SquarePen,
  Table2,
  Trash2,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type * as React from "react";
import { COPY } from "../copy.ts";
import { recordsHref, timelineHref } from "../hooks/useStore.ts";
import type { Route } from "../hooks/useStore.ts";
import { cn } from "../lib/utils.ts";
import type { SyncStatus } from "../store.ts";
import { OWN_PAGES } from "./HomePage.tsx";
import { RollBranch } from "./RollBranch.tsx";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

/*
  The sidebar: every construct in a Roll, one click away.

  Events are only one of the things a Roll keeps. Notes, to-dos, records,
  people, places, money and files each have their own page, and each is
  listed here rather than behind a "More" button, so what a Roll can hold is
  visible at a glance. Built like shadcn/ui's sidebar: a header, groups of
  links with a label, and a footer, drawn in a sheet on a narrow screen.
*/

interface Item {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Routes that light this item up. */
  routes: Route["name"][];
  /** Needs the notes, to-dos and files a store with views offers. */
  views?: boolean;
  count?: number | null;
}

export interface SidebarProps {
  name: string;
  sync: SyncStatus;
  route: Route;
  /** The store reads notes, to-dos and files: their pages are offered. */
  views: boolean;
  /** Collections (folders under notes/) and how many records each holds, once read. */
  collections: { name: string; count: number }[] | null;
  savedSearches: [string, string][];
  counts: { todos: number | null; issues: number | null; conflicts: number };
  /** The sync light, drawn by the app because it owns the sync state. */
  syncIndicator: React.ReactNode;
  newMenu: React.ReactNode;
  onShortcuts(): void;
  /** Called after any link is followed, so a sheet can close. */
  onNavigate?(): void;
}

export function AppSidebar({ name, sync, route, views, collections, savedSearches, counts, syncIndicator, newMenu, onShortcuts, onNavigate }: SidebarProps) {
  const groups: { label: string; items: Item[] }[] = [
    {
      label: "",
      items: [
        { href: "#/", label: "Home", icon: House, routes: ["home"], views: true },
        { href: "#/timeline", label: "Timeline", icon: Rows3, routes: ["timeline"] },
        { href: "#/upcoming", label: "Upcoming & to-dos", icon: ListTodo, routes: ["upcoming"], views: true, count: counts.todos },
        { href: "#/issues", label: "Issues", icon: CircleAlert, routes: ["issues"], views: true, count: counts.issues },
      ],
    },
    {
      label: "Knowledge",
      items: [
        { href: "#/notes", label: "Notes", icon: NotebookText, routes: ["notes"], views: true },
        { href: "#/bookmarks", label: "Bookmarks", icon: Link2, routes: ["bookmarks"], views: true },
        { href: "#/records", label: "Records", icon: Table2, routes: ["records"], views: true },
        { href: "#/files", label: "Files", icon: Paperclip, routes: ["files"], views: true },
      ],
    },
    {
      label: "People & places",
      items: [
        { href: "#/contacts", label: "Contacts", icon: Users, routes: ["contacts"], views: true },
        { href: "#/organizations", label: "Organizations", icon: Building2, routes: ["organizations"], views: true },
        { href: "#/places", label: "Places", icon: MapPin, routes: ["places"], views: true },
      ],
    },
    {
      label: "Money & things",
      items: [
        { href: "#/ledger", label: "Ledger", icon: Wallet, routes: ["ledger"], views: true },
        { href: "#/inventory", label: "Inventory", icon: Package, routes: ["inventory"], views: true },
        { href: "#/series", label: "Series", icon: TrendingUp, routes: ["series"], views: true },
      ],
    },
    {
      label: "Organize",
      items: [
        { href: "#/topics", label: COPY.topics, icon: Hash, routes: ["topics"] },
        { href: "#/deleted", label: "Deleted", icon: Trash2, routes: ["deleted"] },
        ...(counts.conflicts > 0 ? [{ href: "#/conflicts", label: "Conflicts", icon: GitMerge, routes: ["conflicts"] as Route["name"][], count: counts.conflicts }] : []),
      ],
    },
  ];

  const query = route.name === "timeline" ? route.query.trim() : "";
  // People, organizations, places, inventory and bookmarks are collections with pages of their own, listed above.
  const tables = collections?.filter((c) => !OWN_PAGES[c.name.toLowerCase()]) ?? null;
  const collection = route.name === "records" ? route.collection.toLowerCase() : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-1 px-3 pt-3 pb-2">
        <a href="#/" onClick={onNavigate} className="truncate rounded px-2 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {name}
        </a>
        <RollBranch status={sync} className="px-2" />
        <div className="-ml-0.5">{syncIndicator}</div>
      </header>

      <div className="px-3 pb-2">{newMenu}</div>

      <nav aria-label="Sections" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-2">
        {groups.map((g) => {
          const items = g.items.filter((i) => views || !i.views);
          if (!items.length) return null;
          return (
            <div key={g.label || "main"} className="flex flex-col gap-0.5">
              {g.label && <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">{g.label}</p>}
              <ul className="flex flex-col gap-0.5">
                {items.map((i) => (
                  <li key={i.href}>
                    <SidebarLink
                      href={i.href}
                      icon={i.icon}
                      current={i.routes.includes(route.name) && !(i.routes.includes("records") && collection) && !(i.routes.includes("timeline") && query)}
                      count={i.count}
                      onClick={onNavigate}
                    >
                      {i.label}
                    </SidebarLink>
                    {i.routes.includes("records") && tables && tables.length > 0 && (
                      <ul className="ml-4 flex flex-col gap-0.5 border-l border-border pl-2">
                        {tables.map((c) => (
                          <li key={c.name}>
                            <SidebarLink href={recordsHref(c.name)} current={collection === c.name.toLowerCase()} count={c.count} onClick={onNavigate} small>
                              {c.name}
                            </SidebarLink>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}

        {savedSearches.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Saved searches</p>
            <ul className="flex flex-col gap-0.5">
              {savedSearches.map(([key, q]) => (
                <li key={key}>
                  <SidebarLink href={timelineHref(`@${key}`)} icon={Bookmark} current={query === `@${key}` || query === q} onClick={onNavigate} title={q}>
                    {key}
                  </SidebarLink>
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>

      <footer className="border-t border-border px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onShortcuts} className="w-full justify-start text-muted-foreground">
          <Keyboard aria-hidden="true" />
          {COPY.shortcutsTitle}
        </Button>
      </footer>
    </div>
  );
}

function SidebarLink({
  href,
  icon: Icon,
  current,
  count,
  children,
  onClick,
  small,
  title,
}: {
  href: string;
  icon?: LucideIcon;
  current: boolean;
  count?: number | null;
  children: React.ReactNode;
  onClick?(): void;
  small?: boolean;
  title?: string;
}) {
  return (
    <a
      href={href}
      title={title}
      onClick={onClick}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        small ? "py-1 text-[0.8125rem]" : "py-1.5",
        current ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {!!count && <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{count}</span>}
    </a>
  );
}

export interface NewAction {
  label: string;
  hint: string;
  icon: LucideIcon;
  /** A heading the menu lists it under. */
  group?: string;
  onSelect(): void;
}

/** One button for everything that can be written, every construct, in groups. */
export function NewMenu({ actions, className }: { actions: NewAction[]; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className={cn("w-full justify-start", className)}>
          <Plus aria-hidden="true" />
          New
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(36rem,var(--radix-popover-content-available-height))] w-72 overflow-y-auto p-1">
        {groupsOf(actions).map(([group, list]) => (
          <div key={group} role="group" aria-label={group || undefined}>
            {group && <p className="px-2.5 pb-0.5 pt-2 text-xs font-medium text-muted-foreground">{group}</p>}
            <ul className="flex flex-col">
              {list.map((a) => (
                <li key={a.label}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      a.onSelect();
                    }}
                    className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <a.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">{a.label}</span>
                      <span className="text-xs text-muted-foreground">{a.hint}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** The actions in their groups, in the order the groups first appear. */
function groupsOf(actions: NewAction[]): [string, NewAction[]][] {
  const groups = new Map<string, NewAction[]>();
  for (const a of actions) groups.set(a.group ?? "", [...(groups.get(a.group ?? "") ?? []), a]);
  return [...groups];
}

export const NEW_ICONS = {
  event: SquarePen,
  note: NotebookPen,
  todo: ListTodo,
  record: Table2,
  file: Paperclip,
  reminder: AlarmClock,
  issue: CircleAlert,
  expense: Wallet,
  reading: TrendingUp,
  contact: Users,
  organization: Building2,
  place: MapPin,
  thing: Package,
  bookmark: Bookmark,
};

export const NEW_HINTS = {
  reminder: "A to-do with a time to be reminded",
  issue: "Something wrong, open until it's fixed",
  expense: "Something paid for, on the ledger",
  reading: "A number to follow: odometer, weight",
  contact: "A person, with how to reach them",
  organization: "A company, a club, a shop",
  place: "Somewhere, within somewhere else",
  thing: "Something you own, its warranty",
  file: "A scan, a manual, a receipt",
};
