# pi-llm-provider

Configurable dynamic LLM gateway provider for [Pi](https://pi.dev).

Works with [NewAPI](https://github.com/QuantumNous/new-api) and other OpenAI-compatible gateways that expose `/v1/models`.

Fetches the model list at startup and registers a Pi provider, so multiple machines stay in sync without hand-editing `models.json`.

## Features

- **Configurable** base URL, API key, and provider id
- Auto-discover models from `GET {baseUrl}/v1/models`
- Family-aware API routing:
  - GPT → `openai-responses`
  - Claude → `anthropic-messages`
  - DeepSeek / Kimi / GLM / Gemini / Grok / MiniMax → `openai-completions`
- Hand-tuned overrides for known models (context, thinking, cost)
- Heuristics for newly added models
- Filters non-chat models (image / embedding / tts / …)

## Install

```bash
pi install git:github.com/xiaohei-info/pi-llm-provider
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/xiaohei-info/pi-llm-provider"
  ]
}
```

Then:

```bash
pi update --extensions
```

## Configure

All settings are read from **environment variables** or **`~/.pi/agent/llm-provider.env`**  
(env vars win over the file).

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `LLM_API_KEY` | yes | — | Gateway API key |
| `LLM_BASE_URL` | yes | — | Gateway origin, e.g. `https://newapi.example.com` (with or without `/v1`) |
| `LLM_PROVIDER` | no | `llm` | Pi provider id used in `--model provider/model` |

### File example

```bash
cat > ~/.pi/agent/llm-provider.env <<'EOF'
LLM_API_KEY=sk-your-key
LLM_BASE_URL=https://newapi.example.com
LLM_PROVIDER=newapi
EOF
chmod 600 ~/.pi/agent/llm-provider.env
```

### Env example

```bash
export LLM_API_KEY=sk-your-key
export LLM_BASE_URL=https://newapi.example.com
export LLM_PROVIDER=newapi
```

> Do **not** commit real API keys.

### Backwards-compatible aliases

These older names still work if the `LLM_*` keys are unset:

- `NEWAPI_API_KEY` → `LLM_API_KEY`
- `NEWAPI_BASE_URL` → `LLM_BASE_URL`
- `NEWAPI_PROVIDER` → `LLM_PROVIDER`
- file `~/.pi/agent/newapi.env` is also loaded (lower priority than `llm-provider.env`)

## Adaptive compaction (Pi 1.2.0 or newer)

Adaptive compaction is opt-in and applies only to this extension's provider. Add
these keys to the existing `~/.pi/agent/llm-provider.env` (or export them as
environment variables, which take precedence):

```dotenv
LLM_COMPACTION_ENABLED=true
LLM_COMPACTION_WINDOW_BOUNDARY=500000
LLM_COMPACTION_LARGE_WINDOW_RATIO=0.5
LLM_COMPACTION_SMALL_WINDOW_RATIO=0.8
```

| Key | Default | Meaning |
| --- | --- | --- |
| `LLM_COMPACTION_ENABLED` | `false` | Accepts `true` or `false` (case insensitive). |
| `LLM_COMPACTION_WINDOW_BOUNDARY` | `500000` | Positive integer; windows strictly greater than this use the large-window ratio. |
| `LLM_COMPACTION_LARGE_WINDOW_RATIO` | `0.5` | Ratio in `(0, 1]` for windows above the boundary. |
| `LLM_COMPACTION_SMALL_WINDOW_RATIO` | `0.8` | Ratio in `(0, 1]` for windows at or below the boundary. |

With these defaults, a 1,000,000-token window triggers at 500,000 tokens, and a
500,000-token window triggers at 400,000 tokens. The threshold is inclusive
(`tokens >= contextWindow * ratio`) and uses Pi's effective context usage/window,
not a separately configured fixed reserve. These ratios control when compaction
starts; Pi's existing compaction settings control how much history is kept and
how the summary is generated.

Set `LLM_COMPACTION_ENABLED=false` to disable the adaptive policy. Pi's native
threshold and overflow handling remain enabled according to Pi's own settings;
the extension never changes those settings. Invalid adaptive configuration logs
an error and disables only this policy. Configuration is read when the extension
loads, so editing the file does not update an already loaded session.

The policy checks restored sessions, tree navigation, model selection and
`agent_settled`, and waits for an idle session without queued messages. It works
without UI in RPC mode and waits for compaction callbacks before returning from
the event handler. Unknown usage is skipped. Repeated events share an in-flight
guard; native/manual attempts suppress immediate competing adaptive work. A
failed attempt needs both new history and a 60-second cooldown before retrying
on a later event. A successful summary still above the threshold needs growth of
at least `max(1024, 5% of window)` from the previous attempt's usage before another
attempt, unless usage has first fallen below the threshold. There is no retry
polling timer. Native protection can act earlier than the adaptive ratio.

Local verification: `npm test` (Node with `--experimental-strip-types` support).
The SDK tests use Pi 1.2.0 with fixture catalogues, responses and summaries; they
exercise the real compaction lifecycle without contacting a real model service.

## Usage

```bash
pi --list-models
pi --model newapi/claude-sonnet-5          # if LLM_PROVIDER=newapi
pi --model llm/gpt-5.4-mini               # if LLM_PROVIDER=llm (default)
```

## How model metadata is chosen

1. Live lookup against OpenRouter's public model index (context window, max output, pricing, input modalities, reasoning support — best-effort and non-blocking). Context/max output apply to every model unless its `OVERRIDES` entry sets `pinLimits: true`; pricing/modalities/reasoning fill in only where `OVERRIDES` has no value
2. Exact match in `OVERRIDES` (api / thinking / compat / cost / context), filling whatever OpenRouter missed
3. Family heuristics from the model id
4. Safe OpenAI-compatible defaults (`contextWindow=128k`)

Protocol-level settings — `api` kind, `compat` flags and `thinkingLevelMap` — always come from `OVERRIDES` or heuristics; OpenRouter never overrides them.

To tune a model permanently, edit `OVERRIDES` in `extensions/llm-provider.ts` and push.

## Multi-machine

On each machine:

1. Install Pi
2. Install this package
3. Create the same `~/.pi/agent/llm-provider.env`

When the gateway adds/removes models, every machine picks it up on next Pi start.

Update the extension everywhere:

```bash
pi update --extensions
```

## Conflict with static `models.json`

If you previously defined the same provider id in `~/.pi/agent/models.json`, remove it so the dynamic list wins:

```json
{
  "providers": {}
}
```

## License

MIT
