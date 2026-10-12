// Mocked Agent SDK bridge: no network and no worker runtime.
const calls = []
globalThis.__qwenworkSDKCalls = calls
export function jobToken(cb) { return { type: 'jobToken', cb } }
export class ProcessTransport { constructor(o) { this.options = o } }
export function query({ prompt, options }) {
  calls.push(options)
  if (options.model === 'explode') {
    return (async function* () {
      throw new Error('upstream rejected the call: Authorization: Bearer COSY.abc.def and eyJhbGciOiJIUzI1NiJ9.payload.sig')
    })()
  }
  const msg = prompt
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } }
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'fixture reply' }] } }
    yield { type: 'result', result: 'fixture result', is_error: false }
  })()
}
export async function assertSDKCall(expectedModel, getAuth) {
  if (globalThis.__qwenworkSDKCalls.length !== 1) throw new Error('SDK query was not called')
  const o = calls[0]
  if (o.model !== expectedModel || o.auth.type !== 'jobToken' || !o.env.QODERCN_SERVER_ENDPOINT) throw new Error('SDK bridge configured incorrectly')
  const token = await o.auth.cb()
  const auth = await getAuth()
  if (token === null) { if (auth.access && (!auth.expires || auth.expires > Date.now())) throw new Error('SDK rejected a live Magpie token') } else if (token.token !== auth.access) throw new Error('SDK did not reuse Magpie access token')
}
export function resetSDKCalls() { globalThis.__qwenworkSDKCalls.length = 0 }
