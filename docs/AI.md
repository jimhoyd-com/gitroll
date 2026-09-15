> **Experimental, not part of GitRoll 0.1.** Hidden in release builds. To try it, set `GITROLL_EXPERIMENTAL=ai` before running `gitroll`.

# Ask your Roll with your own AI

GitRoll can answer questions like "When was the AC last serviced?" or "How much have I paid Carlos?" using an AI model you run yourself. It's optional, and off until you set it up.

## Set up

Pick the app you use:

```bash
gitroll ai ollama
```

| Command | Works with |
| --- | --- |
| `gitroll ai ollama [--model llama3.2]` | [Ollama](https://ollama.com). Run `ollama pull llama3.2` first. |
| `gitroll ai lmstudio` | LM Studio's local server |
| `gitroll ai llamacpp` | `llama-server` from llama.cpp |
| `gitroll ai custom --endpoint <url> --model <name>` | Anything with an OpenAI-compatible API |
| `gitroll ai off` | Turns Ask off |

Then ask from the terminal, or with the **Ask** button next to the search box:

```bash
gitroll ask "What problems did we have with the bathroom?"
```

## How it works and what's sent

1. GitRoll picks the events most related to your question, on your computer.
2. It sends your question and only those events to the model.
3. The model must cite the events it used. GitRoll shows those events under the answer so you can check them.

By default GitRoll only talks to models on this computer (`localhost` or `127.0.0.1`). To use a model elsewhere, add `--allow-remote`. The address must use https, and your question and matching events will leave your computer. If the service needs a key, pass `--api-key-env NAME`: GitRoll reads the key from that environment variable and never stores it.

AI settings are saved on your computer only, never in the Roll, so collaborators each choose their own. To turn Ask off for everyone who uses a Roll, add `ai: false` to its `.gitroll/config.yaml`.

Answers can be wrong. The cited events are the record.
