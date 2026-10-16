// Integration check of the QwenWork provider, with a fake account and upstream.
// Covered:
// - Defaults and configuration validation fail before any request.
// - Device login, model listing and refresh target the configured hosts.
// - Chat is rewritten as QwenWork's agent_chat_generation request: the host's
//   tools ride along, and tool calls come back structured — both the native
//   delta.tool_calls kind and the inline <tool_call> text kind.
// - A lapsed sign-in fails before another chat request.
// - Client-facing errors carry no token-shaped text.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { QwenWorkAuthPlugin } from './index.mjs'
import { _internal } from './vendor/qoder.mjs'

const names = ['CLIENT_ID', 'WEB', 'OPENAPI', 'API', 'RSA_PUBLIC_KEY', 'COSY_VERSION']
const savedEnv = Object.fromEntries(names.map(k => [k, process.env['QWENWORK_' + k]]))
const originalFetch = globalThis.fetch
const checks = []
let requests = 0
// the agent_chat requests the mock saw, decoded
let agentChats = []
try {
  for (const k of names) delete process.env['QWENWORK_' + k]
  globalThis.fetch = () => { requests++; throw new Error('Unexpected network request') }
  const defaults = await QwenWorkAuthPlugin({ client: {} })
  const defaultLogin = new URL((await defaults.auth.methods[0].authorize()).url)
  assert.equal(defaultLogin.origin, 'https://gateway.qwenwork.cn')
  assert.equal(defaultLogin.searchParams.get('client_id'), 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb')
  assert.equal(defaultLogin.searchParams.get('redirect_uri'), 'qwenwork-cn://')
  assert.equal(requests, 0)
  checks.push('Verified desktop defaults produce login URL without network access')

  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const values = {
    CLIENT_ID: 'integration-fixture-client', WEB: 'https://web.example.invalid',
    OPENAPI: 'https://account.example.invalid', API: 'https://model.example.invalid',
    RSA_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }), COSY_VERSION: 'fixture-version',
  }
  for (const [k, v] of Object.entries(values)) process.env['QWENWORK_' + k] = v
  for (const bad of ['http://web.example.invalid', 'https://user:pass@web.example.invalid', 'https://web.example.invalid/path', 'https://web.example.invalid?x=1']) {
    process.env.QWENWORK_WEB = bad
    await assert.rejects(QwenWorkAuthPlugin({ client: {} }), /QWENWORK_WEB/)
  }
  process.env.QWENWORK_WEB = values.WEB
  process.env.QWENWORK_RSA_PUBLIC_KEY = 'invalid'
  await assert.rejects(QwenWorkAuthPlugin({ client: {} }), /QWENWORK_RSA_PUBLIC_KEY/)
  process.env.QWENWORK_RSA_PUBLIC_KEY = values.RSA_PUBLIC_KEY
  checks.push('Endpoint and RSA key validation reject invalid inputs')

  let auth
  let rejectRefresh = false
  // how the mock's agent_chat answers: a list of SSE bodies, one per call
  const agentReplies = []
  const sse = (delta, finish = null) => `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) })}\n\n`
  globalThis.fetch = async (input, init = {}) => {
    requests++
    const url = new URL(input)
    if (url.hostname === 'account.example.invalid') {
      const body = init.body ? JSON.parse(init.body) : undefined
      switch (url.pathname) {
        case '/api/v1/deviceToken/poll':
          assert.ok(url.searchParams.get('verifier'))
          return Response.json({ token: 'fake-device', refresh_token: 'fake-device-refresh', user_id: 'fixture-user', expires_in: 3600 })
        case '/api/v1/adapter/user/account-context':
          return Response.json({ data: {
            user: { id: 'fixture-user', name: 'Fixture', email: '' },
            plan: { name: 'Fixture Plan', next_refresh_date: '2026-11-01T00:00:00Z' },
            quota: { total: 2000, used: 17.8348, remaining: 1982.1652, exceeded: false },
          } })
        case '/api/v1/deviceToken/refresh':
          assert.equal(body.target, 'c')
          if (rejectRefresh) return Response.json({ error: 'expired' }, { status: 401 })
          assert.equal(body.refresh_token, 'fake-device-refresh')
          return Response.json({ token: 'fake-device-next', refresh_token: 'fake-device-refresh-next', expires_in: 3600 })
        default: throw new Error('Unexpected account path: ' + url.pathname)
      }
    }
    assert.equal(url.hostname, 'model.example.invalid')
    assert.match(init.headers.Authorization, /^Bearer COSY\./)
    assert.equal(init.headers['Cosy-Version'], values.COSY_VERSION)
    assert.equal(init.headers['Cosy-ClientType'], '6')
    assert.equal(init.headers['Cosy-Business-Product'], 'qoder_work')
    const payload = JSON.parse(Buffer.from(init.headers.Authorization.split('.')[1], 'base64'))
    assert.equal(payload.cosyVersion, values.COSY_VERSION)
    if (url.pathname === '/algo/api/v2/model/list') {
      return Response.json({ chat: [], qwork: [{ key: 'fixture-model', enable: false, display_name: 'Fixture model', max_input_tokens: 200000 }] })
    }
    if (url.pathname === '/algo/api/v2/service/pro/sse/agent_chat_generation') {
      agentChats.push(JSON.parse(_internal.decodeBody(init.body)))
      const reply = agentReplies.shift()
      if (reply instanceof Response) return reply
      if (typeof reply === 'string') return new Response(reply, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      return new Response([sse({ role: 'assistant', content: 'hello fixture reply' }), sse({}, 'stop'), 'data: {"body":"[DONE]"}\n\n'].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    throw new Error('Unexpected model path: ' + url.pathname)
  }
  const plugin = await QwenWorkAuthPlugin({ client: { auth: { set: async ({ path, body }) => { assert.equal(path.id, 'qwenwork'); auth = body } } } })
  const config = {}
  await plugin.config(config)
  assert.deepEqual(Object.keys(config.provider), ['qwenwork'])
  assert.deepEqual(config.provider.qwenwork.models, {})
  assert.equal(plugin.auth.provider, 'qwenwork')
  assert.equal(typeof plugin.auth.usage, 'function', 'the provider reports usage')
  assert.match(plugin.auth.icon, /^data:image\/png;base64,/, 'the provider carries its own icon')
  assert.equal(plugin.auth.methods.length, 1)
  const login = await plugin.auth.methods[0].authorize()
  const loginURL = new URL(login.url)
  assert.equal(loginURL.origin, values.WEB)
  assert.equal(loginURL.searchParams.get('client_id'), values.CLIENT_ID)
  auth = { ...(await login.callback()), type: 'oauth' }
  assert.equal(auth.accountId, 'Fixture')
  checks.push('QwenWork registration and device login use configured identity')

  const catalog = await plugin.provider.models({ models: {} }, { auth })
  assert.equal(catalog['fixture-model'].providerID, 'qwenwork')
  assert.equal(catalog['fixture-model'].capabilities.toolcall, true)

  const usage = await plugin.auth.usage(async () => auth)
  assert.equal(usage.signIn, 'kept')
  assert.equal(usage.plan, 'Fixture Plan')
  assert.equal(usage.until, '2026-11-01T00:00:00.000Z')
  assert.deepEqual(usage.windows, [{ name: 'Credits', used: (100 * 17.8348) / 2000, display: '17.83 / 2000 credits' }])
  const usageGone = await plugin.auth.usage(async () => ({ ...auth, expires: Date.now() - 1 }))
  assert.equal(usageGone.signIn, 'expired')
  checks.push('Usage reports the account\'s credits and plan')

  const loader = await plugin.auth.loader(async () => auth)
  const chat = (over = {}) => ({ model: 'fixture-model', messages: [{ role: 'user', content: 'fixture prompt' }], ...over })

  // A plain prompt: the host's system message rides along, the provider's own
  // words sit above it, and the answer comes back as one completion.
  const plain = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ messages: [{ role: 'system', content: 'host rules' }, { role: 'user', content: 'fixture prompt' }] })) })
  assert.equal(plain.status, 200)
  const plainBody = await plain.json()
  assert.equal(plainBody.choices[0].message.content, 'hello fixture reply')
  assert.equal(plainBody.choices[0].finish_reason, 'stop')
  assert.equal(agentChats[0].model_config.key, 'fixture-model')
  assert.match(agentChats[0].system[0].text, /^You are QwenWork/)
  assert.match(agentChats[0].system[0].text, /host rules/)
  checks.push('Chat is rewritten as QwenWork\'s agent request with the host\'s system message')

  // The host's tools ride along; a native tool_calls answer comes back structured.
  const tools = [{ type: 'function', function: { name: 'lookup', description: 'find it', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }]
  agentReplies.push([
    sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }),
    sse({}, 'tool_calls'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const called = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools, tool_choice: 'auto' })) })
  assert.equal(called.status, 200)
  const calledBody = await called.json()
  assert.deepEqual(calledBody.choices[0].message.tool_calls, [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }])
  assert.equal(calledBody.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(agentChats[1].tools, [{ type: 'function', function: { name: 'lookup', description: 'find it', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }])
  checks.push('The host\'s tools ride along and a tool call comes back structured')

  // A model that emits its call as inline <tool_call> text has it lifted out,
  // and no markup reaches the caller: the leak this replaces never shows.
  agentReplies.push([
    sse({ role: 'assistant', content: 'Let me look.<tool_call>{"name":"read","arguments":{"path":"/tmp/x"}}</tool_call>' }),
    sse({}, 'tool_calls'),
    'data: {"body":"[DONE]"}\n\n',
  ].join(''))
  const inline = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools })) })
  assert.equal(inline.status, 200)
  const inlineBody = await inline.json()
  assert.ok(!inlineBody.choices[0].message.content.includes('<tool_call>'), 'no markup in the text')
  assert.deepEqual(inlineBody.choices[0].message.tool_calls, [{ id: inlineBody.choices[0].message.tool_calls[0].id, type: 'function', function: { name: 'read', arguments: '{"path":"/tmp/x"}' } }])
  assert.equal(inlineBody.choices[0].finish_reason, 'tool_calls')
  checks.push('Inline <tool_call> text is lifted into structured tool calls')

  // A tool result turn maps back as Qoder's tool message.
  agentReplies.push([sse({ role: 'assistant', content: 'done' }), sse({}, 'stop'), 'data: {"body":"[DONE]"}\n\n'].join(''))
  const withResult = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ tools, messages: [
    { role: 'user', content: 'fixture prompt' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_fixture', content: 'the result' },
  ] })) })
  assert.equal(withResult.status, 200)
  assert.ok(agentChats[3].messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_fixture' && m.content === 'the result'))
  checks.push('Tool results ride back as tool messages')
  // Streaming keeps the SSE shape magpie's client expects.
  const streamed = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat({ stream: true })) })
  assert.equal(streamed.status, 200)
  const streamText = await streamed.text()
  assert.match(streamText, /chat.completion.chunk/)
  assert.match(streamText, /data: \[DONE\]/)
  checks.push('Stream requests return one SSE completion')

  // A lapsed sign-in fails before another chat request.
  rejectRefresh = true
  auth = { ...auth, expires: Date.now() - 1 }
  const denied = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('X-Magpie-Sign-In'), 'expired')
  checks.push('Invalid Magpie access token fails before another chat request')

  // An upstream failure carries no token-shaped text.
  rejectRefresh = false
  auth.expires = Date.now() + 3_600_000
  agentReplies.push(new Response(JSON.stringify({ message: 'boom: Authorization: Bearer COSY.abc.def and eyJhbGciOiJIUzI1NiJ9.payload.sig' }), { status: 500 }))
  const leaked = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(chat()) })
  const bodyText = await leaked.text()
  assert.equal(leaked.status, 500)
  assert.ok(!/Bearer\s+(?!\[redacted\])\S/.test(bodyText) && !bodyText.includes('COSY.') && !/ey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\./.test(bodyText), 'no bearer, COSY or jwt leaks in the client-facing error')
  checks.push('Client-facing errors carry no token-shaped text')

  const dir = new URL('./', import.meta.url)
  const report = {
    status: 'passed', kind: 'mocked provider integration; no live QwenWork requests', checks,
    sourceSha256: createHash('sha256').update(await readFile(new URL('./vendor/qoder.mjs', dir))).digest('hex'),
    adapterSha256: createHash('sha256').update(await readFile(new URL('./index.mjs', dir))).digest('hex'),
  }
  await writeFile(new URL('./verification.json', dir), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  globalThis.fetch = originalFetch
  for (const k of names) {
    if (savedEnv[k] === undefined) delete process.env['QWENWORK_' + k]
    else process.env['QWENWORK_' + k] = savedEnv[k]
  }
}
