export type ProviderId = "openrouter" | "huggingface" | "gemini"

export type AvatarState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "happy"
  | "concerned"

export type Viseme =
  | "sil"
  | "pp"
  | "ff"
  | "th"
  | "dd"
  | "kk"
  | "ch"
  | "ss"
  | "nn"
  | "rr"
  | "aa"
  | "ee"
  | "ih"
  | "oh"
  | "ou"

export interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  provider?: ProviderId
  at: number
}

export interface ProviderSettings {
  openrouterModel: string
  huggingfaceModel: string
  geminiModel: string
  huggingfaceClientId: string
  googleClientId: string
  googleProjectId: string
  language: "de-DE" | "en-US"
  autoSpeak: boolean
  motion: boolean
}

export const PROVIDERS: Record<
  ProviderId,
  { name: string; short: string; color: string; model: keyof ProviderSettings }
> = {
  openrouter: {
    name: "OpenRouter",
    short: "OR",
    color: "#78a9ff",
    model: "openrouterModel",
  },
  huggingface: {
    name: "Hugging Face",
    short: "HF",
    color: "#f5b847",
    model: "huggingfaceModel",
  },
  gemini: {
    name: "Google Gemini",
    short: "G",
    color: "#8ac7ff",
    model: "geminiModel",
  },
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  openrouterModel: "~openai/gpt-latest",
  huggingfaceModel: "openai/gpt-oss-120b:fastest",
  geminiModel: "gemini-3.7-flash",
  huggingfaceClientId: "",
  googleClientId: "",
  googleProjectId: "",
  language: "de-DE",
  autoSpeak: true,
  motion: true,
}

const TOKEN_PREFIX = "avatar-ai:token:"
const OAUTH_PREFIX = "avatar-ai:oauth:"
const SETTINGS_KEY = "avatar-ai:settings"

export function loadSettings(): ProviderSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS
  try {
    const stored = window.localStorage.getItem(SETTINGS_KEY)
    return stored
      ? { ...DEFAULT_SETTINGS, ...(JSON.parse(stored) as Partial<ProviderSettings>) }
      : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: ProviderSettings) {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function getToken(provider: ProviderId): string | null {
  if (typeof window === "undefined") return null
  return window.sessionStorage.getItem(`${TOKEN_PREFIX}${provider}`)
}

export function setToken(provider: ProviderId, token: string) {
  window.sessionStorage.setItem(`${TOKEN_PREFIX}${provider}`, token)
}

export function clearToken(provider: ProviderId) {
  window.sessionStorage.removeItem(`${TOKEN_PREFIX}${provider}`)
}

function base64Url(bytes: Uint8Array) {
  let binary = ""
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)))
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

export function randomUrlSafe(length = 48) {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)))
}

export async function createPkce() {
  const verifier = randomUrlSafe(64)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(new Uint8Array(digest)) }
}

export interface PendingOAuth {
  provider: ProviderId
  verifier: string
  redirectUri: string
  state: string
  createdAt: number
  clientId?: string
}

export function savePendingOAuth(value: PendingOAuth) {
  window.sessionStorage.setItem(`${OAUTH_PREFIX}${value.provider}`, JSON.stringify(value))
}

export function takePendingOAuth(provider: ProviderId): PendingOAuth | null {
  const key = `${OAUTH_PREFIX}${provider}`
  const raw = window.sessionStorage.getItem(key)
  window.sessionStorage.removeItem(key)
  if (!raw) return null
  try {
    const pending = JSON.parse(raw) as PendingOAuth
    return Date.now() - pending.createdAt < 10 * 60 * 1000 ? pending : null
  } catch {
    return null
  }
}

export async function beginOAuth(provider: ProviderId, settings: ProviderSettings) {
  if (provider === "gemini") {
    throw new Error("Gemini wird über Google Identity Services verbunden.")
  }

  const { verifier, challenge } = await createPkce()
  const state = randomUrlSafe(24)
  const root = `${window.location.origin}${window.location.pathname}`
  const callback = new URL(root)
  callback.searchParams.set("oauth_provider", provider)
  const redirectUri = callback.toString()

  savePendingOAuth({
    provider,
    verifier,
    redirectUri,
    state,
    createdAt: Date.now(),
    clientId:
      provider === "huggingface"
        ? settings.huggingfaceClientId || `${window.location.origin}/.well-known/oauth-cimd`
        : undefined,
  })

  if (provider === "openrouter") {
    const authorize = new URL("https://openrouter.ai/auth")
    authorize.searchParams.set("callback_url", redirectUri)
    authorize.searchParams.set("code_challenge", challenge)
    authorize.searchParams.set("code_challenge_method", "S256")
    window.location.assign(authorize.toString())
    return
  }

  const authorize = new URL("https://huggingface.co/oauth/authorize")
  authorize.searchParams.set(
    "client_id",
    settings.huggingfaceClientId || `${window.location.origin}/.well-known/oauth-cimd`,
  )
  authorize.searchParams.set("redirect_uri", redirectUri)
  authorize.searchParams.set("response_type", "code")
  authorize.searchParams.set("scope", "openid profile inference-api")
  authorize.searchParams.set("state", state)
  authorize.searchParams.set("code_challenge", challenge)
  authorize.searchParams.set("code_challenge_method", "S256")
  window.location.assign(authorize.toString())
}

export async function finishOAuthFromLocation(): Promise<ProviderId | null> {
  const params = new URLSearchParams(window.location.search)
  const provider = params.get("oauth_provider") as ProviderId | null
  const code = params.get("code")
  const error = params.get("error")
  if (!provider || (!code && !error)) return null

  const clean = new URL(window.location.href)
  ;["oauth_provider", "code", "state", "error", "error_description"].forEach((key) =>
    clean.searchParams.delete(key),
  )
  window.history.replaceState({}, "", clean.toString())
  if (error) throw new Error(params.get("error_description") || error)

  const pending = takePendingOAuth(provider)
  if (!pending || !code) throw new Error("Die OAuth-Anmeldung ist abgelaufen. Bitte erneut verbinden.")
  const returnedState = params.get("state")
  if (provider === "huggingface" && returnedState !== pending.state) {
    throw new Error("OAuth-Sicherheitsprüfung fehlgeschlagen.")
  }

  if (provider === "openrouter") {
    const response = await fetch("https://openrouter.ai/api/v1/auth/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: pending.verifier,
        code_challenge_method: "S256",
      }),
    })
    const body = (await response.json()) as { key?: string; error?: { message?: string } }
    if (!response.ok || !body.key) throw new Error(body.error?.message || "OpenRouter konnte nicht verbunden werden.")
    setToken(provider, body.key)
    return provider
  }

  const response = await fetch("https://huggingface.co/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: pending.clientId || "",
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    }),
  })
  const body = (await response.json()) as { access_token?: string; error_description?: string }
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || "Hugging Face konnte nicht verbunden werden.")
  }
  setToken(provider, body.access_token)
  return provider
}

export async function chat(
  provider: ProviderId,
  settings: ProviderSettings,
  messages: Message[],
  signal?: AbortSignal,
) {
  const token = getToken(provider)
  if (!token) throw new Error(`${PROVIDERS[provider].name} ist noch nicht verbunden.`)
  const compact = messages.slice(-12).map(({ role, content }) => ({ role, content }))
  const system = {
    role: "system",
    content:
      settings.language === "de-DE"
        ? "Du bist Avatar AI, eine freundliche, präzise persönliche Sprachassistentin. Antworte natürlich, kompakt und auf Deutsch, sofern der Nutzer keine andere Sprache wählt."
        : "You are Avatar AI, a warm and precise personal voice assistant. Reply naturally and concisely in English unless the user chooses another language.",
  }

  if (provider === "gemini") {
    if (!settings.googleProjectId) throw new Error("Für Gemini fehlt die Google-Cloud-Projekt-ID.")
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiModel)}:generateContent`,
      {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-goog-user-project": settings.googleProjectId,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system.content }] },
          contents: compact.map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }],
          })),
          generationConfig: { temperature: 0.7, maxOutputTokens: 900 },
        }),
      },
    )
    const body = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      error?: { message?: string }
    }
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("")
    if (!response.ok || !text) throw new Error(body.error?.message || "Gemini hat keine Antwort geliefert.")
    return text
  }

  const endpoint =
    provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : "https://router.huggingface.co/v1/chat/completions"
  const model = provider === "openrouter" ? settings.openrouterModel : settings.huggingfaceModel
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(provider === "openrouter"
        ? { "HTTP-Referer": window.location.origin, "X-Title": "Avatar AI" }
        : {}),
    },
    body: JSON.stringify({ model, messages: [system, ...compact], temperature: 0.72, max_tokens: 900 }),
  })
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    error?: { message?: string } | string
  }
  const text = body.choices?.[0]?.message?.content
  const error = typeof body.error === "string" ? body.error : body.error?.message
  if (!response.ok || !text) throw new Error(error || "Das Modell hat keine Antwort geliefert.")
  return text
}

export const VISEMES: Viseme[] = [
  "sil",
  "pp",
  "ff",
  "th",
  "dd",
  "kk",
  "ch",
  "ss",
  "nn",
  "rr",
  "aa",
  "ee",
  "ih",
  "oh",
  "ou",
]

export function visemeAt(text: string, index: number): Viseme {
  const fragment = text.slice(Math.max(0, index), index + 3).toLowerCase()
  const char = fragment[0] || ""
  if (!char || /[\s.,!?;:()\-]/.test(char)) return "sil"
  if (/^(sch|ch|j)/.test(fragment)) return "ch"
  if (/^(th)/.test(fragment)) return "th"
  if (/^(ph|f|v|w)/.test(fragment)) return "ff"
  if (/^(p|b|m)/.test(fragment)) return "pp"
  if (/^(t|d)/.test(fragment)) return "dd"
  if (/^(k|g|q)/.test(fragment)) return "kk"
  if (/^(s|z|ß|x)/.test(fragment)) return "ss"
  if (/^(n|l)/.test(fragment)) return "nn"
  if (/^r/.test(fragment)) return "rr"
  if (/^(au|ou|u)/.test(fragment)) return "ou"
  if (/^(o|ö)/.test(fragment)) return "oh"
  if (/^(e|ä)/.test(fragment)) return "ee"
  if (/^(i|y|ü)/.test(fragment)) return "ih"
  return "aa"
}

export function emotionFor(text: string): AvatarState {
  const value = text.toLowerCase()
  if (/warn|vorsicht|leider|problem|fehler|nicht möglich|cannot|sorry/.test(value)) return "concerned"
  if (/gern|freut|geschafft|perfekt|super|great|happy|glad/.test(value)) return "happy"
  return "speaking"
}

export function id() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
