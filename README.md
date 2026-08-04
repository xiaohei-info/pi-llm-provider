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
