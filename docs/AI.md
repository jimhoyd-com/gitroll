# Ask your Roll

GitRoll can answer questions from your own events — "When did we last roll back a deploy?", "How much have I paid Carlos?" — using an AI model **you** choose. It is off until you set it up, every answer links to the events it came from, and nothing it produces is saved without you saving it.

## Set it up

In the app, click the ✨ button in the header. From a terminal:

```bash
gitroll ai
```

That lists the ways to run a model, with the ones on your own computer first:

| Command | What it is | What leaves your computer |
| --- | --- | --- |
| `gitroll ai ollama` | [Ollama](https://ollama.com). Run `ollama pull llama3.2` first. | Nothing |
| `gitroll ai lmstudio` | LM Studio's local server | Nothing |
| `gitroll ai llamacpp` | `llama-server` from llama.cpp | Nothing |
| `gitroll ai openai` | OpenAI, using `OPENAI_API_KEY` | Your question and the matching events |
| `gitroll ai openrouter` | OpenRouter, using `OPENROUTER_API_KEY` | Your question and the matching events |
| `gitroll ai custom --endpoint <url> --model <name>` | Anything with an OpenAI-compatible API | Depends on the address |

Pick a different model with `gitroll ai ollama --model qwen2.5`, or `--model` in the settings dialog.

## Check it works

```bash
gitroll ai test
```

This makes a real request and tells you which thing is wrong when something is:

- **Nothing answered** — the model isn't running, with that provider's own start-up hint.
- **404 at that address** — the address is usually meant to end in `/v1`.
- **The key isn't set** — `OPENAI_API_KEY` isn't in this terminal, so there is nothing to send.
- **The key was refused** — the server answered 401 or 403, so the key is wrong or can't use that model.
- **It doesn't have that model** — with the names it does have, and the command to pick one.

The settings dialog has the same test, and it tests **what you typed, before it is saved**: nobody should have to save a wrong address to find out that it is wrong.

## What is sent, and what is never sent

With a model on your computer, nothing leaves it. With a hosted provider:

- **Sent:** your question, and the text of the events GitRoll picked as relevant — including their titles, tags, amounts and file names.
- **Never sent:** attachments themselves, and any event GitRoll didn't pick.
- **Never stored:** your API key. GitRoll stores the *name* of an environment variable (`OPENAI_API_KEY`) and reads the variable when it makes a request. No key is ever written to your settings file, and none ever goes near a Roll.

GitRoll refuses a non-local address unless you choose it on purpose, and refuses a remote one that isn't `https://`.

## Turning it off

```bash
gitroll ai off     # keeps your settings; gitroll ai on brings it back
gitroll ai forget  # removes them entirely
```

A Roll can also turn Ask off **for everyone who has it**, which is the right thing for a log that must never be read by a model:

```yaml
# .gitroll/config.yaml
ai: false
```

GitRoll honours that whatever any individual has set up, and the app says so rather than hiding the button.

## Asking

```bash
gitroll ask "What broke in checkout last month?"
gitroll ask "How much have we spent on the rebuild?" --json
```

In the app, type in the search box and press **Ask**.

Every answer cites the events it used, and each citation is a link to that event. **If nothing is cited, treat the answer as a guess**: GitRoll says so rather than quietly presenting it as a record.

## Drafting, never writing

AI never writes to your Roll.

- **In the app**, *Start an event from this* puts the answer in the composer, with links to the events it came from. It is a draft on screen until you press Save.
- **In a terminal**, `gitroll summary` drafts an update from what you logged (`--since 2026-09-01`, or the last week by default) and prints it. Nothing is saved; it ends with the command to keep it if you want to, and you edit it first.

That is deliberate. A logbook is worth having because it says what actually happened; a model that can edit it unattended is a logbook that might not.

## How it picks events

Plain keyword overlap, done on your computer, over the events' own text. There is no index, no embedding, and nothing cached: the events sent are picked from the Roll as it is right now. That is why an answer can only be as good as what you wrote down — and why a question that matches nothing says so.
