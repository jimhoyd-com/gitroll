// Entry point for the local GitRoll app.
import { LocalStore } from "./local.ts";
import { showStopped, startApp } from "./ui.ts";

const result = await LocalStore.connect();
if ("error" in result) showStopped(result.error);
else startApp(result.store);
