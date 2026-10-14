import {
  AlarmClock,
  Library,
  Bookmark,
  Building2,
  CircleAlert,
  GitMerge,
  House,
  Keyboard,
  ListTodo,
  MapPin,
  NotebookPen,
  Package,
  Paperclip,
  Plus,
  SquarePen,
  Table2,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type * as React from "react";
import { COPY } from "../copy.ts";
import type { Route } from "../hooks/useStore.ts";
import { cn } from "../lib/utils.ts";
import type { SyncStatus } from "../store.ts";
import { RollBranch } from "./RollBranch.tsx";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";

/*
  The sidebar: two places. Home, where one box finds and records and what
  needs you now is listed under it; and the Library, where everything the
  Roll keeps can be browsed. Conflicts show up here only while there are some.
*/

export interface SidebarProps {
  name: string;
  sync: SyncStatus;
  route: Route;
  counts: { conflicts: number };
  /** The sync light, drawn by the app because it owns the sync state. */
  syncIndicator: React.ReactNode;
  newMenu: React.ReactNode;
  onShortcuts(): void;
}

export function AppSidebar({ name, sync, route, counts, syncIndicator, newMenu, onShortcuts }: SidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-col gap-1 px-3 pt-3 pb-2">
        <a href="#/" className="truncate rounded px-2 text-lg font-bold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {name}
        </a>
        <RollBranch status={sync} className="px-2" />
        <div className="-ml-0.5">{syncIndicator}</div>
      </header>

      <nav aria-label="Sections" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2">
        <SidebarLink href="#/" icon={House} current={route.name === "home"}>
          Home
        </SidebarLink>
        <SidebarLink href="#/library" icon={Library} current={inLibrary(route)}>
          Library
        </SidebarLink>
        {counts.conflicts > 0 && (
          <SidebarLink href="#/conflicts" icon={GitMerge} current={route.name === "conflicts"} count={counts.conflicts}>
            Conflicts
          </SidebarLink>
        )}
      </nav>

      <footer className="flex flex-col gap-1 border-t border-border px-3 py-2">
        {newMenu}
        <Button variant="ghost" size="sm" onClick={onShortcuts} className="w-full justify-start text-muted-foreground">
          <Keyboard aria-hidden="true" />
          {COPY.shortcutsTitle}
        </Button>
      </footer>
    </div>
  );
}

/** Every page but Home and an item's own page is somewhere in the Library. */
export const inLibrary = (route: Route): boolean => route.name !== "home" && route.name !== "entry" && route.name !== "conflicts";

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
      {Icon && <Icon className={cn("size-4 shrink-0", current ? "text-foreground" : "text-primary")} aria-hidden="true" />}
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
