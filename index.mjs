// QwenWork provider that delegates chat to the bundled QwenWork Agent SDK.
// Magpie auth only supplies the host job token; model routing, COSY, WASM and
// endpoint overrides stay in the vendor SDK.
const sdk = process.env.QWENWORK_AGENT_SDK_TEST_MODE === '1' ? await import('./check-sdk.mjs?test') : await import('@qoder-ai/qoder-agent-sdk')
import { createPublicKey, createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, mkdirSync, chmodSync, statSync, writeFileSync, renameSync, rmSync, openSync, closeSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const pluginDir = decodeURIComponent(realpathSync(fileURLToPath(new URL('.', import.meta.url))))
// The Agent SDK's worker runtime, run as a child process. Two facts shape this:
//
//  - The worker is not shipped in the npm package; its postinstall downloads it
//    from the SDK's release CDN. Magpie installs plugins with --ignore-scripts,
//    so that download never runs -- the plugin fetches the worker itself.
//  - The npm package is the "global" build; QwenWork's gateway only accepts the
//    "cn" build, whose brand is a compile-time constant baked into the worker
//    ("cn"==(U="global")). The two builds differ from each other throughout, but
//    for our purposes only this constant matters, and it is rewritten below.
//
// The patched worker is cached under the user's own 0700 directory, replaced
// only when its bytes change, so a same-machine writer can't swap the
// executable between loads.
const runtimeDir = `${homedir()}/.cache/magpie/qwenwork-worker-runtime`
const runtimePath = `${runtimeDir}/qoder-worker-runtime.obf.mjs`
const BRAND_GLOBAL = '"cn"==(UYs="global")'
const BRAND_CN = '"cn"==(UYs="cn")'
const BRAND_GLOBAL2 = '"cn"==(nfd="global")'
const BRAND_CN2 = '"cn"==(nfd="cn")'
const WORKER_MEMBER = 'qoder-worker-runtime/qoder-worker-runtime.obf.mjs'

// pinToCn rewrites the one compile-time brand constant and refuses a worker
// that still names the global build, so a wrong gateway is never asked.
function pinToCn(source) {
  let text = source.toString('utf8')
  if (text.includes(BRAND_GLOBAL)) text = text.replace(BRAND_GLOBAL, BRAND_CN)
  if (text.includes(BRAND_GLOBAL2)) text = text.replace(BRAND_GLOBAL2, BRAND_CN2)
  if (/"cn"==\(\w+="global"\)/.test(text)) {
    throw new Error('QwenWork: the Agent SDK worker still names the global build; the plugin cannot pin it to QwenWork\'s gateway')
  }
  return Buffer.from(text, 'utf8')
}

// memberOfTar reads one regular file out of a plain (uncompressed) tar.
function memberOfTar(buf, want) {
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '')
    if (!name) break
    const size = parseInt(buf.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim(), 8) || 0
    const type = String.fromCharCode(buf[off + 156])
    if (name === want && (type === '0' || type === '\0')) return buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

// downloadWorker fetches the release tarball the SDK's manifest names, checks
// its published sha256, and returns the runtime file inside it.
async function downloadWorker(manifest) {
  const wr = manifest?.workerRuntime
  if (!wr?.urlTemplate) throw new Error('QwenWork: the Agent SDK manifest names no worker runtime to download')
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch] ?? process.arch
  const plat = { darwin: 'darwin', linux: 'linux', win32: 'win32' }[process.platform] ?? process.platform
  const url = wr.urlTemplate.replace('{target}', `${plat}-${arch}`)
  console.error(`[qwenwork] fetching the Agent SDK worker runtime once: ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(600_000) })
  if (!res.ok) throw new Error(`QwenWork: worker runtime download failed: HTTP ${res.status}`)
  const tgz = Buffer.from(await res.arrayBuffer())
  try {
    const want = (await (await fetch(`${url}.sha256`, { signal: AbortSignal.timeout(60_000) })).text()).trim().split(/\s+/)[0]
    const got = createHash('sha256').update(tgz).digest('hex')
    if (want && got !== want) throw new Error(`QwenWork: worker runtime checksum mismatch (expected ${want}, got ${got})`)
  } catch (e) {
    if (String(e.message).includes('checksum mismatch')) throw e
  }
  const member = memberOfTar(gunzipSync(tgz), WORKER_MEMBER)
  if (!member) throw new Error(`QwenWork: the worker runtime download has no ${WORKER_MEMBER}`)
  return member
}

let staged
function stageRuntime() {
  if (staged) return staged
  const installed = `${pluginDir}/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`
  staged = (async () => {
    let source
    if (existsSync(installed)) source = readFileSync(installed)
    else {
      const manifest = JSON.parse(readFileSync(`${pluginDir}/node_modules/@qoder-ai/qoder-agent-sdk/dist/runtime-manifest.json`, 'utf8'))
      source = await downloadWorker(manifest)
    }
    const pinned = pinToCn(source)
    try { if (statSync(runtimePath).size === pinned.length && readFileSync(runtimePath).equals(pinned)) return runtimePath } catch {}
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    chmodSync(runtimeDir, 0o700)
    const tmp = `${runtimePath}.${randomUUID()}.tmp`
    try {
      const fd = openSync(tmp, 'w', 0o600)
      try { writeFileSync(fd, pinned) } finally { closeSync(fd) }
      chmodSync(tmp, 0o600)
      renameSync(tmp, runtimePath)
    } catch (e) {
      try { rmSync(tmp, { force: true }) } catch {}
      throw e
    }
    return runtimePath
  })()
  return staged
}
const defaults = JSON.parse(readFileSync(new URL('./defaults.json', import.meta.url), 'utf8'))
// The provider's picture, as magpie reads it: a data:image URI on the auth hook.
const pluginIcon = (() => {
  try { return `data:image/png;base64,${readFileSync(new URL('./icon.png', import.meta.url)).toString('base64')}` } catch { return '' }
})()
const CHAT = '@ai-sdk/openai-compatible'

function setting(name) {
  const value = (process.env['QWENWORK_' + name] ?? defaults[name])?.trim()
  if (!value) throw new Error(`QWENWORK_${name} is not configured`)
  return value
}
function origin(name) {
  let url
  try { url = new URL(setting(name)) } catch { throw new Error(`QWENWORK_${name} must be an https address`) }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error(`QWENWORK_${name} must be an https origin`)
  return url.origin
}
const sdkEnv = () => ({
  HOME: process.env.HOME, USER: process.env.USER, PATH: process.env.PATH, SHELL: process.env.SHELL,
  TERM: process.env.TERM ?? 'xterm-256color',
  NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy,
  QODER_WORK_INTEGRATION_MODE: '1', QODER_SITE: 'cn', QODERWORK_IS_CN: 'true',
  QODERCN_SERVER_ENDPOINT: origin('API'), QODER_SCENE: 'qwork', QODERCN_SCENE: 'qwork',
  QODER_CONFIG_DIR: new URL('./sdk-config', import.meta.url).pathname,
  QODERCN_CONFIG_DIR: new URL('./sdk-config', import.meta.url).pathname,
})
function sdkAuth(getAuth) {
  return sdk.jobToken(async () => {
    const a = await getAuth()
    if (a?.type !== 'oauth' || !String(a.access ?? '').trim()) return null
    if (a.expires > 0 && a.expires <= Date.now()) return null
    return { token: a.access, ...(a.expires > 0 ? { expiresAt: a.expires } : {}) }
  })
}
function textOf(content) {
  return typeof content === 'string' ? content : (content ?? []).map(p => p?.text ?? '').join('')
}
function userText(messages) {
  const m = [...(messages ?? [])].reverse().find(m => m.role === 'user')
  const text = textOf(m?.content).trim()
  if (!text) throw new Error('QwenWork: only text prompts are supported here, and this request carried none')
  return text
}
function prompt(messages) {
  return async function* () {
    yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText(messages) }] }, parent_tool_use_id: null }
  }()
}
async function sdkTransport() {
  // ponytail: bun's Worker cannot host this runtime; run it as a child process instead.
  return new sdk.ProcessTransport({ pathToQoderCLIExecutable: await stageRuntime() })
}
// A request may not run forever: without this a stalled query holds a child
// process for good. Overridable for slow prompts.
const REQUEST_TIMEOUT_MS = Number(process.env.QWENWORK_REQUEST_TIMEOUT_MS) > 0 ? Number(process.env.QWENWORK_REQUEST_TIMEOUT_MS) : 300_000
function completionFrom(result, model, stream) {
  const base = { id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: result }, finish_reason: 'stop' }] }
  if (!stream) return new Response(JSON.stringify(base), { headers: { 'Content-Type': 'application/json' } })
  const chunk = { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: result }, finish_reason: null }] }
  const done = { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  const body = [chunk, done].map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}
function errorResponse(message, status = 502) {
  return Response.json({ error: { message: publicMessage(message), type: 'qwenwork_error', code: status } }, { status })
}
// A message that goes back to the caller: never a token, a key, or an
// unbounded upstream dump. Long text is cut; anything token-shaped is redacted.
function publicMessage(value) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim()
  text = text
    .replace(/\b(Bearer|COSY)[.\w-]*/gi, '$1 [redacted]')
    .replace(/\bey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
  return text.length > 300 ? text.slice(0, 300) + '…' : text
}

export async function QwenWorkAuthPlugin({ client }) {
  // Warm the worker runtime now (it may download once); a request awaits it.
  stageRuntime().catch(() => {})
  const clientId = setting('CLIENT_ID')
  const web = origin('WEB')
  const openapi = origin('OPENAPI')
  const api = origin('API')
  const rsa = setting('RSA_PUBLIC_KEY').replaceAll('\\n', '\n')
  try { if (createPublicKey(rsa).asymmetricKeyType !== 'rsa') throw new Error() } catch { throw new Error('QWENWORK_RSA_PUBLIC_KEY must be an RSA public key in PEM form') }
  const site = { id: 'qwenwork', name: 'QwenWork', clientId, web, openapi, api, rsaKey: rsa, cosyVersion: setting('COSY_VERSION'), redirect: 'qwenwork-cn://', deviceOnly: true, deviceRefreshTarget: 'c', modelScene: 'qwork', listAllModels: true, clientType: '6', businessProduct: 'qoder_work', sessionType: 'qoder_work', userInfoPath: '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing', normalizeUser: v => (v?.data ?? v)?.user ?? (v?.data ?? v), models: [] }
  const { makePlugin } = await import('./vendor/qoder.mjs')
  const plugin = await makePlugin(site)({ client })
  delete plugin.auth.usage
  plugin.auth.icon = pluginIcon
  const modelCatalog = plugin.provider.models
  plugin.provider.models = async (provider, options) => Object.fromEntries(Object.entries(await modelCatalog(provider, options)).map(([key, m]) => [key, { ...m, api: { ...m.api, url: api } }]))
  plugin.auth.loader = async getAuth => ({
    baseURL: api,
    apiKey: 'qwenwork-sdk',
    async fetch(input, init = {}) {
      let authNow = await getAuth()
      if (authNow?.type !== 'oauth' || !String(authNow.access ?? '').trim() || (authNow.expires > 0 && authNow.expires <= Date.now())) return errorResponse('QwenWork: the sign-in lapsed — sign in again', 401)
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (!url.pathname.endsWith('/chat/completions')) return errorResponse('QwenWork: only chat completions are served', 404)
      let chat
      try { chat = JSON.parse(typeof init.body === 'string' ? init.body : await input.clone().text()) } catch { return errorResponse('QwenWork: a request that is not JSON', 400) }
      const model = String(chat.model ?? '').replace(/^qwenwork\//, '')
      const abortController = new AbortController()
      const deadline = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS)
      try {
        const promptText = prompt(chat.messages)
        const q = sdk.query({
          prompt: promptText,
          options: {
            cwd: process.cwd(), auth: sdkAuth(getAuth), model,
            transport: await sdkTransport(),
            maxTurns: 1, persistSession: false, tools: [], settingSources: [],
            // The SDK runs in a scratch cwd with every tool disallowed, so
            // nothing it is offered can act; bypassPermissions avoids a prompt
            // for the one turn. The chat never becomes a coding agent.
            disallowedTools: ['*'], permissionMode: 'bypassPermissions',
            env: sdkEnv(), abortController,
            controlRequestTimeoutMs: 60000,
            debug: process.env.QWENWORK_SDK_DEBUG === '1',
            debugFile: process.env.QWENWORK_SDK_DEBUG === '1' ? new URL('./sdk-debug-magpie.log', import.meta.url).pathname : undefined,
            stderr: x => process.env.QWENWORK_SDK_DEBUG === '1' && console.error('[qwenwork-sdk stderr]', x),
          },
        })
        let answer = ''
        let final
        for await (const event of q) {
          if (event.type === 'assistant') answer += (event.message?.content ?? []).filter(p => p?.type === 'text').map(p => p.text).join('')
          if (event.type === 'result') {
            final = event
            if (typeof event.result === 'string') answer ||= event.result
            break
          }
        }
        if (q.close) await q.close().catch(() => {})
        if (final?.is_error) return errorResponse(typeof final.result === 'string' ? final.result : 'QwenWork returned an error')
        if (!answer.trim()) return errorResponse('QwenWork: the SDK returned no text')
        return completionFrom(answer, chat.model, chat.stream === true)
      } catch (e) {
        return errorResponse(e?.name === 'AbortError' ? 'QwenWork: the request timed out' : (e?.message ?? String(e)))
      } finally {
        clearTimeout(deadline)
      }
    },
  })
  return plugin
}
