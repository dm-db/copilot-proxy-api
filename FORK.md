# Running copilot-proxy-api from a fork

This branch (`native-messages-1m`) carries a local patch on top of
[voidsteed/copilot-proxy-api](https://github.com/voidsteed/copilot-proxy-api):
Claude models that Copilot serves on its native `/v1/messages` endpoint are
passed through unchanged (including the `anthropic-beta` header). Upstream
converts these requests to `/chat/completions`, where Copilot enforces
`max_prompt_tokens` (200k), and additionally trims prompts to ~200k tokens.
Through the native endpoint Copilot accepted a 510k-token prompt, so Claude
Code can use the full 1M context window of Opus 5.5 / Sonnet 5.5.

The proxy runs from a local build of this branch instead of
`npx copilot-proxy-api@latest`, so it only changes when you sync and rebuild.

Paths below assume the clone lives in `~/github/copilot-proxy-api`; adjust if not.

## Prerequisites

- Node.js and npm (Bun is **not** required for daily use)
- git
- sudo rights for `npm link` (the global npm prefix is `/usr/local`)
- Bun only if you want to run the upstream test suite (see [Syncing with upstream](#syncing-with-upstream))

## One-time setup

1. Fork `voidsteed/copilot-proxy-api` on GitHub, then clone it and add upstream:

   ```bash
   git clone https://github.com/<you>/copilot-proxy-api.git ~/github/copilot-proxy-api
   cd ~/github/copilot-proxy-api
   git remote add upstream https://github.com/voidsteed/copilot-proxy-api.git
   git switch native-messages-1m      # or: git switch -c native-messages-1m
   ```

2. Install dependencies and build:

   ```bash
   npm install --ignore-scripts       # the "prepare" script needs bunx; skip it
   npx tsdown                         # produces dist/main.mjs
   ```

   `npm install` creates `package-lock.json`; upstream uses `bun.lock`, so keep
   it out of commits:

   ```bash
   echo package-lock.json >> .git/info/exclude
   ```

3. Link the clone as the global `copilot-proxy-api` command:

   ```bash
   sudo npm link
   ```

   This creates `/usr/local/bin/copilot-proxy-api` → `/usr/local/lib/node_modules/copilot-proxy-api`
   → your clone. The link points at the clone, so later rebuilds take effect
   without running `sudo npm link` again — only redo it if you move the clone.

4. Point the `cproxy` alias at the linked command (in `~/.alias`):

   ```bash
   alias cproxy='copilot-proxy-api start --account-type business'
   ```

   Then `source ~/.alias` or open a new shell.

5. Verify the link:

   ```bash
   npm ls -g copilot-proxy-api
   # /usr/local/lib
   # └── copilot-proxy-api@0.10.32 -> ./../../../home/<you>/github/copilot-proxy-api

   readlink -f "$(command -v copilot-proxy-api)"
   # /home/<you>/github/copilot-proxy-api/dist/main.mjs
   ```

6. Keep Claude Code on a 200k default in `~/.claude/settings.json`:

   ```json
   "autoCompactWindow": 200000
   ```

   Opus 5.5 and Sonnet 5.5 have a native 1M context window in Claude Code, so
   no `[1m]` model suffix is needed — the auto-compact window alone decides
   how large a session grows. Model IDs stay as they are
   (`claude-opus-5.5`, `claude-sonnet-5.5`).

   Keep Haiku at 100k (Copilot caps Haiku 5.5 prompts at 100k):

   ```json
   "modelSettings": {
     "claude-haiku-5-5": { "autoCompactWindow": 100000 }
   }
   ```

   Do **not** set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the `env` block — it
   overrides every other way of switching described below.

## Every morning

```bash
cproxy
```

Extra flags are passed through, e.g. `cproxy --claude-code` or `cproxy --port 4142`.

Do **not** use `npx copilot-proxy-api@latest` anymore — `npx … @latest` always
downloads the upstream release from npm and ignores the link.

Check that the running proxy is the fork:

```bash
ps -o args= -p "$(ss -ltnp | grep 4141 | grep -oP 'pid=\K\d+')"
```

| Output starts with | Running |
|---|---|
| `… /usr/local/bin/copilot-proxy-api start …` | the fork ✅ |
| `… /.npm/_npx/…/copilot-proxy-api start …` | the npm release ❌ — stop it and start `cproxy` |

To disable the native pass-through for a session (falls back to upstream
behaviour, 200k limit — do not switch Claude Code to 1M while it is off):

```bash
COPILOT_NATIVE_MESSAGES=0 cproxy
```

## Switching between 200k and 1M

The default is 200k (setup step 6). Switch to 1M only for sessions that need
it — Copilot bills per token, every request resends the whole context, and
Copilot reports about 1.33× more input tokens than `count_tokens` does.

| When | 1M | Back to 200k | Persists? |
|---|---|---|---|
| Starting a session | `claude --autocompact auto` | `claude` | No — this launch only |
| Inside a session | `/autocompact auto` | `/autocompact 200k` | **Yes** — saved under the current model in `modelSettings` |

- `auto` is the window tuned for the model: about 967k tokens for Opus 5.5 /
  Sonnet 5.5. A fixed size also works, e.g. `claude --autocompact 500000`.
- Prefer the launch flag; it never changes your saved settings. A handy alias:

  ```bash
  alias c1m='claude --autocompact auto'
  ```

- `/autocompact auto` changes the default for that model until you run
  `/autocompact 200k` again.
- When dropping from 1M to 200k with more than 200k already in context, run
  `/compact` first.
- 1M works only with the fork running. With the npm release, stay at 200k.

## Syncing with upstream

Do this occasionally, or when upstream releases something you need.

```bash
cd ~/github/copilot-proxy-api
git switch native-messages-1m
git fetch upstream
git merge upstream/master           # resolve conflicts, if any (see "The patch" below)
npm install --ignore-scripts
npx tsdown
git push origin native-messages-1m
npm ls -g copilot-proxy-api         # version shown follows the merged package.json
```

Then stop the running proxy (Ctrl+C) and start it again with `cproxy`. No
`sudo npm link` is needed after a sync.

Optional, before pushing or opening a PR — run the upstream checks (needs Bun,
install with `curl -fsSL https://bun.sh/install | bash`):

```bash
bun run verify                      # typecheck + lint + tests
```

## The patch

| File | Change |
|---|---|
| `src/services/copilot/create-native-messages.ts` | New. Calls Copilot's `/v1/messages` and `/v1/messages/count_tokens`, forwarding `anthropic-beta` / `anthropic-version` |
| `src/services/copilot/legacy-thinking.ts` | New. Drops thinking blocks the native endpoint can't verify: unsigned ones, and ones signed on the translated path (Copilot answers `Invalid signature in thinking block`; the request is retried once without them and the signatures are remembered) |
| `src/routes/messages/handler.ts` | Models whose `supported_endpoints` include `/v1/messages` skip translation and `fitContext`; the response (JSON or SSE) is piped back unchanged |
| `src/routes/messages/count-tokens-handler.ts` | Returns Copilot's own count for those models; falls back to the local estimate if Copilot's count fails |
| `src/routes/messages/non-stream-translation.ts` | `translateModelName` is exported |
| `tests/native-messages.test.ts` | New tests for all of the above |

After a merge, check that the patched branch in `handleCompletion` still sits
before `translateToOpenAI`, then run `bun test tests/native-messages.test.ts`.

## Going back to upstream

When the change is merged upstream (or you want to drop the fork):

```bash
sudo npm unlink -g copilot-proxy-api
npm ls -g copilot-proxy-api         # should print "(empty)"
```

and change the alias in `~/.alias` back to:

```bash
alias cproxy='npx copilot-proxy-api@latest start --account-type business'
```

Until upstream has the pass-through, keep `"autoCompactWindow": 200000` and
remove any 1M windows saved with `/autocompact`.
