# opencode-qwenwork-auth — 千问办公（QwenWork）接入 magpie / OpenCode

[English](README.md)

把你的千问办公订阅接成 OpenCode provider：用千问办公自己的设备登录流程登录，
再通过千问办公 Agent SDK 调用它的模型。

> 非官方插件。未经 magpie 审阅，安装前请先看代码。
> 已在 macOS 上对着千问办公 1.2.5 桌面版跑通端到端。

| Provider id | 服务 | 模型 |
|---|---|---|
| `qwenwork` | 千问办公（`gateway.qwenwork.cn`） | 账号自己的 `qwork` 目录 |

本包导出 `QwenWorkAuthPlugin`。

## 安装

从这个 GitHub 仓库安装（推荐）：

```sh
magpie plugin add github:harwinvoid/magpie-plugin-qwenwork
magpie plugin login qwenwork
```

`magpie plugin add` 接受 bun 支持的各种 spec：npm 包、`github:owner/repo` 仓库，
或本地目录。本仓库就是给 `github:` 方式安装用的 —— 这样才会跟随这里的代码、并
收到更新。

安装会把 Agent SDK（`@qoder-ai/qoder-agent-sdk`）作为依赖装好；它需要的
worker 运行时会**在首次使用时自动下载**（见下文）。之后给某个 agent 选
`qwenwork/<模型>` 即可，例如 `magpie claude qwenwork/flash`。

- **之前是从本地目录装的？** 加上 `github:` spec、再删掉本地目录那条，让 magpie
  改为跟踪仓库：
  ```sh
  magpie plugin add github:harwinvoid/magpie-plugin-qwenwork
  magpie plugin rm /你本地/magpie-plugin-qwenwork 的路径
  ```
  登录态会保留，worker 缓存也会复用。
- **在应用里找到它。** 本仓库打了 `magpie-plugin` topic，magpie 会把它列在
  插件 → 发现 → *非官方*（社区插件，未经 magpie 审阅）。可以在那里安装，也可以用
  上面的命令。

## 工作原理

登录使用与千问办公桌面端相同的 PKCE 设备流，随后用自带的 refresh token 持续续期
access token。账号按名称显示，取不到时回退到 id。对话直接交给千问办公 Agent SDK，
由它完成签名（COSY 信封、请求编码）、选定模型路由并固定 scene —— 本插件只负责
提供 host job token。

以下配置取自千问办公桌面端自身的打包文件：

```text
clientId      e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb
web / openapi / api   https://gateway.qwenwork.cn
redirect_uri  qwenwork-cn://
设备流        /device/selectAccounts -> /api/v1/deviceToken/poll
刷新          /api/v1/deviceToken/refresh   (target: "c")
模型          "qwork" scene
```

以上每一项，连同 COSY RSA 公钥，都可以通过 `QWENWORK_*` 环境变量和
`defaults.json` 覆盖。

## worker 运行时、`cn` 构建，以及为何在加载时处理

`@qoder-ai/qoder-agent-sdk` 的两个事实决定了插件的行为：

1. **worker 运行时不在 npm 包里。** 它由该包的 postinstall 从 SDK 的发布 CDN
   下载。而 magpie 是用 `--ignore-scripts` 安装插件的，这个下载永远不会执行 ——
   所以插件自己去下：首次使用时按 SDK `runtime-manifest.json` 里的 URL 模板
   下载一次，并校验其发布的 sha256。（如果包内已有 worker，则直接使用。）

2. **npm 包是 *global* 构建；而千问办公的网关只接受 *cn* 构建。** 品牌是烤在
   worker 里的编译期常量：

   ```js
   // global 构建:   Cn = "cn" === (site = "global")
   // cn 构建:       Cn = "cn" === (site = "cn")
   ```

   npm 上没有发布 cn 包（`@ali/qodercn-agent-sdk-next` 不在公共 npm）。两个构建
   的 worker 文件几乎逐字节不同。因此插件只把这**一个常量**改写成 `cn`，再缓存
   worker —— 见 `index.mjs` 里的 `pinToCn()` 与 `stageRuntime()`。若找不到该常量、
   或仍残留 `global` 品牌标记，插件会直接报错停止，而不是去发一个网关必然会拒的
   请求。

改写后的 worker 缓存在 `~/.cache/magpie/qwenwork-worker-runtime`
（目录 `0700`，文件 `0600`）。

## 说明

- magpie 用 bun 运行插件，而 SDK 默认的 worker transport 在 bun 下起不来；插件
  改为以子进程方式运行 SDK 运行时。改写后的运行时缓存在
  `~/.cache/magpie/qwenwork-worker-runtime`（目录 `0700`，文件 `0600`），
  内容不变时不重写。
- 只支持文本提示词。登录失效会明确报出；单个请求超过
  `QWENWORK_REQUEST_TIMEOUT_MS`（默认 300000 毫秒）会被放弃。
- 对话在临时 cwd 中单轮执行、所有工具禁用 —— 此处的 SDK 只是传输层，不是编码
  agent。返回给调用方的错误会做裁剪并脱敏 token。
- provider 图标用的是千问办公的应用图标，用于标识该产品。
- `QWENWORK_SDK_DEBUG=1` 会把 SDK 自身诊断写入 `sdk-debug-magpie.log`。
- MIT。

## 验证

```sh
node check.mjs     # 离线：mock SDK 与上游
./live-e2e.sh      # 在线：经网关验证模型、对话、流式
```

## 文件

- `index.mjs` — provider：配置、设备登录、Agent SDK 桥接。
- `vendor/qoder.mjs` — 与 Qoder 插件共用的登录与目录代码。
- `defaults.json` — 已核实的桌面端配置。
- `icon.png` — provider 图标，即千问办公应用图标。
- `check.mjs`、`check-sdk.mjs`、`live-e2e.sh` — 离线与在线检查。
