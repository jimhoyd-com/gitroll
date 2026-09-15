import { COPY } from "../copy.ts";

/** Shown when the app on this computer isn't reachable, or this browser isn't signed in. */
export function Stopped({ kind }: { kind: "stopped" | "signed-out" }) {
  const signedOut = kind === "signed-out";
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
      <h1 className="text-lg font-semibold">{signedOut ? COPY.signedOutTitle : COPY.stoppedTitle}</h1>
      <p className="text-sm text-muted-foreground">{signedOut ? COPY.signedOutBody : COPY.stoppedBody}</p>
      {!signedOut && (
        <>
          <p className="text-sm text-muted-foreground">{COPY.stoppedHint}</p>
          <pre className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm">gitroll</pre>
        </>
      )}
    </main>
  );
}
