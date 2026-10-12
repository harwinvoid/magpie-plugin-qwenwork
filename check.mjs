// Integration check of the QwenWork provider, with a fake account and upstream.
// Covered:
// - Defaults and configuration validation fail before any request.
// - Device login, model listing and refresh target the configured hosts.
// - Chat is delegated to the Agent SDK, which reuses Magpie's access token.
// - A lapsed sign-in fails before another SDK chat request.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { QwenWorkAuthPlugin } from './index.mjs'

const names = ['CLIENT_ID', 'WEB', 'OPENAPI', 'API', 'RSA_PUBLIC_KEY', 'COSY_VERSION', 'AGENT_SDK_TEST_MODE']
const savedEnv = Object.fromEntries(names.map(k => [k, process.env['QWENWORK_' + k]]))
const originalFetch = globalThis.fetch
const checks = []
let requests = 0
try {
  for (const k of names) delete process.env['QWENWORK_' + k]
  process.env.QWENWORK_AGENT_SDK_TEST_MODE = '1'
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
          return Response.json({ data: { user: { id: 'fixture-user', name: 'Fixture', email: '' } } })
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
    throw new Error('Unexpected model path: ' + url.pathname)
  }
  const plugin = await QwenWorkAuthPlugin({ client: { auth: { set: async ({ path, body }) => { assert.equal(path.id, 'qwenwork'); auth = body } } } })
  const config = {}
  await plugin.config(config)
  assert.deepEqual(Object.keys(config.provider), ['qwenwork'])
  assert.deepEqual(config.provider.qwenwork.models, {})
  assert.equal(plugin.auth.provider, 'qwenwork')
  assert.equal(plugin.auth.usage, undefined)
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
  auth.expires = 0
  const loader = await plugin.auth.loader(async () => auth)
  const completion = { model: 'fixture-model', messages: [{ role: 'user', content: 'fixture prompt' }], tools: [{ type: 'function', function: { name: 'lookup' } }] }
  const { resetSDKCalls, assertSDKCall } = await import('./check-sdk.mjs?test')
  resetSDKCalls()
  const result = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(completion) })
  assert.equal(result.status, 200)
  const response = await result.json()
  assert.equal(response.choices[0].message.content, 'hello fixture reply')
  assert.equal(response.choices[0].finish_reason, 'stop')
  await assertSDKCall('fixture-model', async () => auth)
  checks.push('Agent SDK bridge answers one JSON chat completion')

  resetSDKCalls()
  const streamed = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify({ ...completion, stream: true }) })
  assert.equal(streamed.status, 200)
  const streamText = await streamed.text()
  assert.match(streamText, /chat.completion.chunk/)
  assert.match(streamText, /data: \[DONE\]/)
  checks.push('Stream requests return one SSE completion')

  rejectRefresh = true
  auth.expires = Date.now() - 1
  const denied = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify(completion) })
  assert.equal(denied.status, 401)
  assert.match((await denied.text()), /sign-in lapsed|sign in again/i)
  checks.push('Invalid Magpie access token fails before another SDK chat request')

  auth.expires = Date.now() + 3_600_000
  const leaked = await loader.fetch(values.API + '/chat/completions', { body: JSON.stringify({ model: 'explode', messages: [{ role: 'user', content: 'x' }] }) })
  const bodyText = await leaked.text()
  assert.equal(leaked.status, 502)
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
