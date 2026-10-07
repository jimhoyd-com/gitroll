import { Bell, BellOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button.tsx";

const KEY = "gitroll.reminderNotifications";

const supported = () => typeof window !== "undefined" && "Notification" in window;
const remembered = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
};
const remember = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // A private window: it is only forgotten next time.
  }
};

/**
 * Browser notifications for reminders, while this page is open. Off until the
 * person presses the button; permission is asked for then and never on load.
 * Only a reminder that comes due after that is told, once: one already due is
 * on the page as Due now. GitRoll runs only when it is run, so a closed tab
 * tells nobody; the calendar file's alarms are for that.
 */
export function ReminderNotifier({ due }: { due: { key: string; title: string }[] }) {
  const [on, setOn] = useState(() => supported() && Notification.permission === "granted" && remembered());
  const [note, setNote] = useState("");
  const told = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!on) {
      told.current = null;
      return;
    }
    // The first time round, everything already due counts as told.
    if (!told.current) {
      told.current = new Set(due.map((d) => d.key));
      return;
    }
    for (const d of due) {
      if (told.current.has(d.key)) continue;
      told.current.add(d.key);
      try {
        new Notification(d.title, { body: "Reminder from GitRoll", tag: d.key });
      } catch {
        // Some browsers allow notifications only from a service worker; the page still shows it.
      }
    }
  }, [on, due]);

  if (!supported()) return null;

  const enable = async () => {
    if (on) {
      setOn(false);
      remember(false);
      setNote("");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      setOn(true);
      remember(true);
      setNote("You'll be notified while this page is open.");
    } else {
      setNote("Your browser isn't allowing notifications from this page. Due reminders still show here as Due now.");
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="secondary" size="sm" aria-pressed={on} onClick={() => void enable()}>
        {on ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />}
        {on ? "Notifications on" : "Notify me"}
      </Button>
      <p role="status" className="text-xs text-muted-foreground">
        {note}
      </p>
    </div>
  );
}
