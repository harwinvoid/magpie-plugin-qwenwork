// QwenWork provider. Chat completions are rewritten as QwenWork's own
// agent_chat_generation request by the vendored adapter (vendor/qoder.mjs):
// the host's tools ride along, tool calls come back structured, and the
// host agent keeps its loop. Magpie auth supplies the account; COSY signing,
// the request codec and the endpoint stay in the adapter.
import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

const defaults = JSON.parse(readFileSync(new URL('./defaults.json', import.meta.url), 'utf8'))
// The provider's picture, as magpie reads it: a data:image URI on the auth hook.
const pluginIcon = (() => {
  try { return `data:image/png;base64,${readFileSync(new URL('./icon.png', import.meta.url)).toString('base64')}` } catch { return '' }
})()

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

// num renders a credit count as magpie shows one: no trailing zeros, at most
// two decimals (1982.1652 -> "1982.17", 2000 -> "2000").
const num = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  return String(Math.round(n * 100) / 100)
}

// The flagship deploys no model catalog. These are the public cloud's qwork
// models, used only when that host answers 503. is_vl / max_input_tokens are
// the public cloud's, not a given flagship's own.
const QWORK_FALLBACK = {
  qwork: [
    { key: 'flash', display_name: '标准', is_vl: false, is_reasoning: false, max_input_tokens: 131072 },
    { key: 'pro', display_name: '高级', is_vl: false, is_reasoning: false, max_input_tokens: 131072 },
    { key: 'qwen3.8-max-preview', display_name: 'Qwen3.8-Max', is_vl: false, is_reasoning: false, max_input_tokens: 131072 },
  ],
}

// enterpriseDomain is the flagship host the user typed: a bare host, or an
// https:// address with no path. An IP, localhost, or a path is none.
function enterpriseDomain(input) {
  let e = String(input ?? '').trim().toLowerCase()
  if (!e) return undefined
  if (/^[a-z][a-z\d+.-]*:\/\//.test(e)) {
    let u
    try { u = new URL(e) } catch { return undefined }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '' && u.pathname !== '/')) return undefined
    if (e.endsWith('/')) e = e.slice(0, -1)
    if (u.hostname + '' !== e.slice('https://'.length)) return undefined
    e = u.hostname
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(e)) return undefined
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(e)) return undefined
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(e)) return undefined
  return e
}

// qwenworkUsage reads the account's credits for magpie's usage bar. The
// account-context the sign-in already uses carries them: quota {total, used,
// remaining, exceeded} in the plan's credit unit, and plan {name, next_refresh
// / next_due}. One window is one pool of credits; when the plan refreshes, that
// time is the window's reset. A flagship account is read on its own host, not
// the public cloud's.
function qwenworkUsage(openapi) {
  return async (getAuth) => {
    let signIn = 'kept'
    try {
      const a = await getAuth()
      if (a?.type !== 'oauth' || !String(a.access ?? '').trim() || (a.expires > 0 && a.expires <= Date.now())) return { error: 'QwenWork: not signed in', signIn: 'expired' }
      const host = enterpriseDomain(a.enterpriseHost)
      const base = host ? `https://${host}` : openapi
      const res = await fetch(`${base}/api/v1/adapter/user/account-context?include=user,plan,quota`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${a.access}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 401 || res.status === 403) return { error: 'QwenWork: the sign-in lapsed — sign in again', signIn: 'expired' }
      if (!res.ok) return { error: `QwenWork: usage read failed (HTTP ${res.status})`, signIn }
      const ctx = (await res.json())?.data ?? {}
      const q = ctx.quota
      const out = { signIn }
      if (ctx.plan?.name) out.plan = String(ctx.plan.name)
      const refresh = ctx.plan?.next_refresh_date ?? ctx.plan?.next_due_date
      if (refresh) out.until = new Date(refresh).toISOString()
      if (q && typeof q === 'object') {
        const total = Number(q.total)
        const remaining = Number(q.remaining)
        const used = Number.isFinite(Number(q.used)) ? Number(q.used) : total - remaining
        if (Number.isFinite(total) && total > 0 && Number.isFinite(used) && used >= 0) {
          out.windows = [{ name: 'Credits', used: Math.min(100, (100 * used) / total), display: `${num(used)} / ${num(total)} credits` }]
        }
      }
      if (!out.windows) out.error = 'QwenWork: the account reports no credits'
      return out
    } catch (e) {
      return { error: String(e?.message ?? e), signIn }
    }
  }
}

export async function QwenWorkAuthPlugin({ client }) {
  const clientId = setting('CLIENT_ID')
  const web = origin('WEB')
  const openapi = origin('OPENAPI')
  const api = origin('API')
  const rsa = setting('RSA_PUBLIC_KEY').replaceAll('\\n', '\n')
  try { if (createPublicKey(rsa).asymmetricKeyType !== 'rsa') throw new Error() } catch { throw new Error('QWENWORK_RSA_PUBLIC_KEY must be an RSA public key in PEM form') }
  const site = {
    id: 'qwenwork', name: 'QwenWork', clientId, web, openapi, api, rsaKey: rsa,
    cosyVersion: setting('COSY_VERSION'), redirect: 'qwenwork-cn://',
    deviceOnly: true, deviceRefreshTarget: 'c', modelScene: 'qwork', listAllModels: true,
    clientType: '6', businessProduct: 'qoder_work', sessionType: 'qoder_work',
    userInfoPath: '/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing',
    normalizeUser: v => (v?.data ?? v)?.user ?? (v?.data ?? v),
    // promoted onto a flagship account's site when its catalog 503s
    qworkFallback: QWORK_FALLBACK,
    models: [],
    // The adapter prefixes this under the host's own system messages; worded
    // for QwenWork, not the Qoder brand the adapter was shared from.
    systemPrompt: 'You are QwenWork (qw), a helpful assistant. Use the instructions below and the tools available to you to assist the user.',
  }
  const { makePlugin, deviceSignIn } = await import('./vendor/qoder.mjs')
  const plugin = await makePlugin(site)({ client })
  plugin.auth.usage = qwenworkUsage(openapi)
  plugin.auth.icon = pluginIcon
  // The public-cloud method above always sends redirect_uri=qwenwork-cn://
  // and only ever yields a personal account. The flagship's
  // /device/selectAccounts refuses that redirect, and serves web, openapi
  // and chat on the enterprise's own host. QWENWORK_ENT_DOMAIN presets it.
  const preset = enterpriseDomain(process.env.QWENWORK_ENT_DOMAIN ?? '')
  plugin.auth.methods.push({
    type: 'oauth',
    label: preset ? `Sign in with QwenWork 企业旗舰版 (${preset})` : 'Sign in with QwenWork 企业旗舰版（输入企业域名）',
    prompts: preset ? [] : [
      {
        type: 'text',
        key: 'domain',
        message: '你企业的千问办公旗舰版域名（企业管理后台地址栏的域名，如 your-company.vpc.qwenwork.cn）',
        placeholder: 'your-company.vpc.qwenwork.cn 或 https://your-company.vpc.qwenwork.cn',
        validate: (v) => (enterpriseDomain(v) ? undefined : '请输入企业域名（或 https:// 开头的完整地址），不要带路径'),
      },
    ],
    authorize: (inputs) => {
      const domain = preset || enterpriseDomain(inputs?.domain)
      if (!domain) throw new Error('请输入企业域名（或设置 QWENWORK_ENT_DOMAIN 环境变量）')
      return deviceSignIn({
        ...site,
        web: `https://${domain}`,
        openapi: `https://${domain}`,
        api: `https://${domain}`,
        redirect: '',
        enterpriseDomain: domain,
        vpc: domain,
      })
    },
  })
  return plugin
}
