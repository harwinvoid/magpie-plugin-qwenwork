# opencode-qwenwork-auth — QwenWork (千问办公) for magpie / OpenCode

[中文说明 / Chinese](README.zh-CN.md)

Your QwenWork subscription as an OpenCode provider: signs in through QwenWork's
own device flow and serves its models over the QwenWork Agent SDK.

> Unofficial. Not reviewed by magpie. Read the code before installing.
> Verified end to end on macOS against the QwenWork 1.2.5 desktop app.

| Provider id | Service | Models |
|---|---|---|
| `qwenwork` | 千问办公 (`gateway.qwenwork.cn`) | the account's own `qwork` catalog |

The package exports `QwenWorkAuthPlugin`.

## Install

From this repository:

```sh
magpie plugin add github:harwinvoid/magpie-plugin-qwenwork
magpie plugin login qwenwork
```

Installing fetches the Agent SDK (`@qoder-ai/qoder-agent-sdk`) as a dependency;
the worker runtime it needs is downloaded on first use (see below). Then pick
`qwenwork/<model>` for an agent, e.g. `magpie claude qwenwork/flash`.

## How it works

Sign-in uses the same PKCE device flow the QwenWork desktop app uses, then
keeps the access token refreshed with its own refresh token. The account is
shown by name, falling back to its id. Chat is handed to the QwenWork Agent SDK,
which signs the request (COSY envelope, request codec), picks the model route
and pins the scene — so the provider only supplies the host job token.

Verified configuration, read from the desktop app's own bundle:

```text
clientId      e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
web / openapi / api   https://gateway.qwenwork.cn
redirect_uri  qwenwork-cn://
device flow   /device/selectAccounts -> /api/v1/deviceToken/poll
refresh       /api/v1/deviceToken/refresh   (target: "c")
models        the "qwork" scene
```

Every value, plus the COSY RSA key, can be overridden through `QWENWORK_*`
environment variables and `defaults.json`.

## The worker runtime, the `cn` build, and why they are handled at load

Two facts about `@qoder-ai/qoder-agent-sdk` shape the plugin:

1. **The worker runtime is not in the npm package.** Its postinstall downloads it
   from the SDK's release CDN. Magpie installs plugins with `--ignore-scripts`, so
   that download never runs — the plugin fetches the worker itself, once, from the
   template in the SDK's `runtime-manifest.json`, and checks the published sha256.
   (A worker already present in the package is used as is.)
2. **The npm package is the *global* build; QwenWork's gateway only accepts *cn*.**
   The brand is a compile-time constant baked into the worker:

   ```js
   // global build:   Cn = "cn" === (site = "global")
   // cn build:       Cn = "cn" === (site = "cn")
   ```

   There is no published cn package (`@ali/qodercn-agent-sdk-next` is not public),
   and the two builds' workers differ almost byte for byte. So the plugin rewrites
   just that one constant to `cn` before caching the worker — see `pinToCn()` and
   `stageRuntime()` in `index.mjs`. If the constant is not found or a `global`
   brand token remains, the plugin stops with a clear error rather than sign
   requests the gateway will reject.

The patched worker is cached under `~/.cache/magpie/qwenwork-worker-runtime`
(dir `0700`, file `0600`).

## Notes

- Magpie runs plugins under bun, where the SDK's default worker transport does
  not start; the provider runs the SDK runtime as a child process instead. The
  patched runtime is cached under `~/.cache/magpie/qwenwork-worker-runtime`
  (dir `0700`, file `0600`) and only rewritten when its bytes change.
- Only text prompts are served. A lapsed sign-in is reported as such, and a
  request is given up after `QWENWORK_REQUEST_TIMEOUT_MS` (default 300000 ms).
- Chat runs one turn in a scratch cwd with every tool disallowed — the SDK is a
  transport here, never a coding agent. The error a caller sees is trimmed and
  token-redacted before it leaves.
- The provider's icon is the QwenWork app icon, used to identify the product.
- `QWENWORK_SDK_DEBUG=1` writes the SDK's own diagnostics to `sdk-debug-magpie.log`.
- MIT.

## Verify

```sh
node check.mjs     # offline, mocked SDK and upstream
./live-e2e.sh      # live: models, chat, streaming through the gateway
```

## Files

- `index.mjs` — the provider: configuration, device sign-in, the Agent SDK bridge.
- `vendor/qoder.mjs` — sign-in and catalog code shared with the Qoder plugin.
- `defaults.json` — verified desktop configuration.
- `icon.png` — the provider's picture, the QwenWork app icon.
- `check.mjs`, `check-sdk.mjs`, `live-e2e.sh` — the offline and live checks.
