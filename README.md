# pi-newapi-provider

Dynamic [NewAPI](https://github.com/QuantumNous/new-api)-compatible provider for [Pi](https://pi.dev).

Fetches `/v1/models` at startup and registers a `newapi` provider, so multiple machines stay in sync without hand-editing `models.json` every time the gateway model list changes.

## Features

- Auto-discover models from the gateway
- Per-family API routing:
  - GPT → `openai-responses`
  - Claude → `anthropic-messages`
  - DeepSeek / Kimi / GLM / Gemini / Grok / MiniMax → `openai-completions`
- Hand-tuned overrides for known models (context window, thinking, cost)
- Heuristics for newly added models
- Filters non-chat models (image / embedding / tts / …)
- Config via env or `~/.pi/agent/newapi.env`

## Install

### Option A — Pi package (recommended)

```bash
pi install git:github.com/xiaohei-info/pi-newapi-provider
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/xiaohei-info/pi-newapi-provider"
  ]
}
```

Then:

```bash
pi update --extensions
```

### Option B — Local extension copy

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL \
  https://raw.githubusercontent.com/xiaohei-info/pi-newapi-provider/main/extensions/newapi-provider.ts \
  -o ~/.pi/agent/extensions/newapi-provider.ts
```

## Configure

Create `~/.pi/agent/newapi.env` (recommended, works for non-interactive shells):

```bash
cat > ~/.pi/agent/newapi.env <<'EOF'
NEWAPI_API_KEY=sk-your-key
NEWAPI_BASE_URL=https://newapi.xiaohei.tech
EOF
chmod 600 ~/.pi/agent/newapi.env
```

Or export env vars:

```bash
export NEWAPI_API_KEY=sk-your-key
export NEWAPI_BASE_URL=https://newapi.xiaohei.tech   # optional
```

> Do **not** commit real API keys. Keep `newapi.env` only on each machine (`chmod 600`).

## Usage

```bash
pi --list-models | rg newapi
pi --model newapi/claude-sonnet-5
pi --model newapi/gpt-5.4-mini
pi --model newapi/deepseek-v4-flash
```

## How model metadata is chosen

1. Exact match in `OVERRIDES` (context / thinking / cost / api)
2. Else family heuristics from the model id
3. Else safe OpenAI-compatible defaults (`contextWindow=128k`)

To tune a model permanently, edit `OVERRIDES` in `extensions/newapi-provider.ts` and push.

## Multi-machine setup

On each machine:

1. Install Pi
2. Install this package (or copy the extension file)
3. Create `~/.pi/agent/newapi.env` with the same key/base URL

When the gateway adds/removes models, every machine picks it up on next Pi start. No `models.json` sync needed.

## Conflict with static `models.json`

If you previously defined a static `newapi` provider in `~/.pi/agent/models.json`, remove it:

```json
{
  "providers": {}
}
```

Pi composes `models.json` above extension-registered providers; a static list would fight the dynamic one.

## License

MIT
