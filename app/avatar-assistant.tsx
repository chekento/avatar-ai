"use client"

import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import Image from "next/image"
import {
  AudioLines,
  Check,
  ChevronRight,
  CircleStop,
  Eraser,
  ExternalLink,
  Link2,
  LogIn,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Unplug,
  Volume2,
  VolumeX,
  Waves,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  type AvatarState,
  DEFAULT_SETTINGS,
  type Message,
  PROVIDERS,
  type ProviderId,
  type ProviderSettings,
  type Viseme,
  beginOAuth,
  chat,
  clearToken,
  emotionFor,
  finishOAuthFromLocation,
  getToken,
  id,
  loadSettings,
  saveSettings,
  setToken,
  visemeAt,
} from "@/lib/avatar/runtime"

type RecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
}

declare global {
  interface Window {
    webkitSpeechRecognition?: new () => RecognitionLike
    SpeechRecognition?: new () => RecognitionLike
    google?: { accounts: { oauth2: { initTokenClient(options: {
      client_id: string
      scope: string
      callback(response: { access_token?: string; expires_in?: number; error?: string; error_description?: string }): void
      error_callback?(error: { type?: string }): void
    }): { requestAccessToken(options?: { prompt?: string }): void } } } }
  }
}

const welcome: Message = {
  id: "welcome",
  role: "assistant",
  content: "Hallo, ich bin Avatar AI. Melde dich einmal per OAuth an – danach können wir direkt miteinander sprechen.",
  at: Date.now(),
}

const stateLabels: Record<AvatarState, string> = {
  idle: "Bereit",
  listening: "Ich höre zu",
  thinking: "Ich denke nach",
  speaking: "Ich spreche",
  happy: "Freut mich",
  concerned: "Aufmerksam",
}

const gestures = ["settle", "look-left", "look-right", "nod", "shift"] as const
type Gesture = (typeof gestures)[number]

function loadGoogleIdentity() {
  if (window.google?.accounts.oauth2) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const old = document.querySelector<HTMLScriptElement>("script[data-avatar-google]")
    if (old) {
      old.addEventListener("load", () => resolve(), { once: true })
      old.addEventListener("error", () => reject(new Error("Google Identity konnte nicht geladen werden.")), { once: true })
      return
    }
    const script = document.createElement("script")
    script.src = "https://accounts.google.com/gsi/client"
    script.async = true
    script.defer = true
    script.dataset.avatarGoogle = "true"
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("Google Identity konnte nicht geladen werden."))
    document.head.appendChild(script)
  })
}

function clock(value: number) {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(value)
}

function readConnections() {
  return {
    openrouter: Boolean(getToken("openrouter")),
    huggingface: Boolean(getToken("huggingface")),
    gemini: Boolean(getToken("gemini")),
  }
}

export function AvatarAssistant() {
  const [provider, setProvider] = useState<ProviderId>("gemini")
  const [loginTarget, setLoginTarget] = useState<ProviderId>("gemini")
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_SETTINGS)
  const [draft, setDraft] = useState<ProviderSettings>(DEFAULT_SETTINGS)
  const [messages, setMessages] = useState<Message[]>([welcome])
  const [input, setInput] = useState("")
  const [avatarState, setAvatarState] = useState<AvatarState>("idle")
  const [viseme, setViseme] = useState<Viseme>("sil")
  const [gesture, setGesture] = useState<Gesture>("settle")
  const [connected, setConnected] = useState<Record<ProviderId, boolean>>({ openrouter: false, huggingface: false, gemini: false })
  const [onboardingOpen, setOnboardingOpen] = useState(true)
  const [menuOpen, setMenuOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [muted, setMuted] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [interim, setInterim] = useState("")
  const [gaze, setGaze] = useState({ x: 0, y: 0 })
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceName, setVoiceName] = useState("")
  const recognitionRef = useRef<RecognitionLike | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const visemeTimer = useRef<number | null>(null)
  const messagePane = useRef<HTMLDivElement | null>(null)

  const model = settings[PROVIDERS[provider].model] as string
  const hasConnection = Object.values(connected).some(Boolean)
  const canRecognize = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  const tone = useMemo(() => avatarState === "listening" ? "cyan" : avatarState === "thinking" ? "amber" : avatarState === "concerned" ? "rose" : avatarState === "idle" ? "green" : "blue", [avatarState])
  const latestAnswer = useMemo(() => [...messages].reverse().find((message) => message.role === "assistant")?.content || welcome.content, [messages])
  const caption = interim || (busy ? `${PROVIDERS[provider].name} formuliert eine Antwort …` : latestAnswer)

  const refreshConnections = useCallback(() => {
    const value = readConnections()
    setConnected(value)
    return value
  }, [])

  useEffect(() => {
    const value = loadSettings()
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setSettings(value)
      setDraft(value)
      const connections = refreshConnections()
      if (Object.values(connections).some(Boolean)) setOnboardingOpen(false)
    })
    void loadGoogleIdentity().catch(() => undefined)
    void finishOAuthFromLocation().then((result) => {
      if (!result) return
      setProvider(result)
      setLoginTarget(result)
      refreshConnections()
      setOnboardingOpen(false)
      setNotice(`${PROVIDERS[result].name} ist verbunden. Du kannst jetzt sprechen.`)
    }).catch((error: unknown) => {
      setOnboardingOpen(true)
      setNotice(error instanceof Error ? error.message : "OAuth ist fehlgeschlagen.")
    })
    return () => { active = false }
  }, [refreshConnections])

  useEffect(() => {
    if (!settings.motion || avatarState !== "idle") return
    let timeout = 0
    const schedule = () => {
      timeout = window.setTimeout(() => {
        const next = gestures[Math.floor(Math.random() * gestures.length)]
        setGesture(next)
        schedule()
      }, 3200 + Math.random() * 3600)
    }
    schedule()
    return () => window.clearTimeout(timeout)
  }, [avatarState, settings.motion])

  useEffect(() => {
    if (!("speechSynthesis" in window)) return
    const update = () => {
      const available = window.speechSynthesis.getVoices()
      setVoices(available)
      if (!voiceName && available.length) {
        const language = settings.language.slice(0, 2).toLowerCase()
        const named = available.find((voice) => voice.lang.toLowerCase().startsWith(language) && /female|anna|katja|vicki|samantha|victoria|google deutsch/i.test(voice.name))
        const local = available.find((voice) => voice.lang.toLowerCase().startsWith(language))
        setVoiceName((named || local || available[0]).name)
      }
    }
    update()
    window.speechSynthesis.addEventListener("voiceschanged", update)
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update)
  }, [settings.language, voiceName])

  useEffect(() => { messagePane.current?.scrollTo({ top: messagePane.current.scrollHeight, behavior: "smooth" }) }, [messages, interim, busy])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 5200)
    return () => window.clearTimeout(timeout)
  }, [notice])
  useEffect(() => () => {
    recognitionRef.current?.stop()
    abortRef.current?.abort()
    if (visemeTimer.current) window.clearInterval(visemeTimer.current)
    if ("speechSynthesis" in window) window.speechSynthesis.cancel()
  }, [])

  const stopSpeaking = useCallback(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel()
    if (visemeTimer.current) window.clearInterval(visemeTimer.current)
    setViseme("sil")
    setAvatarState("idle")
  }, [])

  const speak = useCallback((text: string) => {
    if (muted || !settings.autoSpeak || !("speechSynthesis" in window)) {
      setAvatarState(emotionFor(text))
      window.setTimeout(() => setAvatarState("idle"), 1700)
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = settings.language
    utterance.rate = 1.01
    utterance.pitch = 1.03
    utterance.voice = voices.find((voice) => voice.name === voiceName) || null
    let cursor = 0
    utterance.onstart = () => {
      setAvatarState(emotionFor(text))
      visemeTimer.current = window.setInterval(() => {
        cursor = Math.min(text.length - 1, cursor + Math.max(1, Math.round(text.length / 74)))
        setViseme(visemeAt(text, cursor))
      }, 82)
    }
    utterance.onboundary = (event) => { cursor = event.charIndex; setViseme(visemeAt(text, cursor)) }
    utterance.onend = () => {
      if (visemeTimer.current) window.clearInterval(visemeTimer.current)
      setViseme("sil")
      setAvatarState("idle")
    }
    utterance.onerror = utterance.onend
    window.speechSynthesis.speak(utterance)
  }, [muted, settings.autoSpeak, settings.language, voiceName, voices])

  const sendText = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!text || busy) return
    if (!connected[provider]) {
      setLoginTarget(provider)
      setOnboardingOpen(true)
      setNotice(`Verbinde zuerst ${PROVIDERS[provider].name}.`)
      return
    }
    stopSpeaking()
    const userMessage: Message = { id: id(), role: "user", content: text, provider, at: Date.now() }
    const context = [...messages, userMessage]
    setMessages(context)
    setInput("")
    setInterim("")
    setBusy(true)
    setAvatarState("thinking")
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const answer = await chat(provider, settings, context, controller.signal)
      setMessages((current) => [...current, { id: id(), role: "assistant", content: answer, provider, at: Date.now() }])
      speak(answer)
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        const detail = error instanceof Error ? error.message : "Die Anfrage ist fehlgeschlagen."
        setNotice(detail)
        setMessages((current) => [...current, { id: id(), role: "assistant", content: `Ich konnte nicht antworten: ${detail}`, provider, at: Date.now() }])
        if (/OAuth-Anmeldung ist abgelaufen/i.test(detail)) {
          clearToken(provider)
          refreshConnections()
          setLoginTarget(provider)
          setOnboardingOpen(true)
        }
        setAvatarState("concerned")
        window.setTimeout(() => setAvatarState("idle"), 1800)
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [busy, connected, messages, provider, refreshConnections, settings, speak, stopSpeaking])

  const startListening = useCallback(() => {
    if (busy) return
    if (!connected[provider]) {
      setLoginTarget(provider)
      setOnboardingOpen(true)
      setNotice(`Melde dich zuerst bei ${PROVIDERS[provider].name} an.`)
      return
    }
    if (!canRecognize) {
      setChatOpen(true)
      setNotice("Spracherkennung ist in diesem Browser nicht verfügbar. Du kannst im Chat schreiben.")
      return
    }
    stopSpeaking()
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) return
    const recognition = new Recognition()
    let submitted = false
    recognition.lang = settings.language
    recognition.interimResults = true
    recognition.continuous = false
    recognition.onresult = (event) => {
      let transcript = ""
      let final = false
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0].transcript
        final ||= event.results[index].isFinal
      }
      setInterim(transcript)
      if (final && !submitted) {
        submitted = true
        void sendText(transcript)
      }
    }
    recognition.onerror = (event) => {
      if (event.error !== "no-speech") setNotice(`Mikrofon: ${event.error || "unbekannter Fehler"}`)
      setAvatarState("idle")
      setInterim("")
    }
    recognition.onend = () => {
      recognitionRef.current = null
      setAvatarState((current) => current === "listening" ? "idle" : current)
    }
    recognitionRef.current = recognition
    setAvatarState("listening")
    try { recognition.start() } catch {
      recognitionRef.current = null
      setAvatarState("idle")
      setNotice("Das Mikrofon konnte nicht gestartet werden.")
    }
  }, [busy, canRecognize, connected, provider, sendText, settings.language, stopSpeaking])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setAvatarState("idle")
    setInterim("")
  }, [])

  const connect = useCallback(async (target: ProviderId, nextSettings: ProviderSettings = settings) => {
    setProvider(target)
    setLoginTarget(target)
    if (target !== "gemini") {
      try { await beginOAuth(target, nextSettings) } catch (error) { setNotice(error instanceof Error ? error.message : "OAuth konnte nicht gestartet werden.") }
      return
    }
    if (!nextSettings.googleClientId || !nextSettings.googleProjectId) {
      setDraft(nextSettings)
      setOnboardingOpen(true)
      setNotice("Für Gemini fehlen noch Google Client-ID und Projekt-ID.")
      return
    }
    setSettings(nextSettings)
    saveSettings(nextSettings)
    try {
      await loadGoogleIdentity()
      if (!window.google) throw new Error("Google Identity ist nicht verfügbar.")
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: nextSettings.googleClientId,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        callback: (response) => {
          if (!response.access_token) {
            setNotice(response.error_description || response.error || "Google OAuth ist fehlgeschlagen.")
            return
          }
          setToken("gemini", response.access_token, response.expires_in)
          refreshConnections()
          setProvider("gemini")
          setOnboardingOpen(false)
          setMenuOpen(false)
          setNotice("Google Gemini ist verbunden. Tippe auf das Mikrofon und sprich.")
        },
        error_callback: (error) => setNotice(`Google OAuth: ${error.type || "abgebrochen"}`),
      })
      client.requestAccessToken({ prompt: connected.gemini ? "" : "consent" })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Google OAuth konnte nicht gestartet werden.")
    }
  }, [connected.gemini, refreshConnections, settings])

  const disconnect = (target: ProviderId) => {
    clearToken(target)
    const next = refreshConnections()
    setNotice(`${PROVIDERS[target].name} wurde auf diesem Gerät getrennt.`)
    if (!Object.values(next).some(Boolean)) {
      setLoginTarget("gemini")
      setProvider("gemini")
      setOnboardingOpen(true)
    }
  }

  const saveConfig = () => {
    setSettings(draft)
    saveSettings(draft)
    setSettingsOpen(false)
    setNotice("Einstellungen gespeichert.")
  }

  const chooseProvider = (target: ProviderId) => {
    setProvider(target)
    if (!connected[target]) {
      setLoginTarget(target)
      setDraft(settings)
      setOnboardingOpen(true)
    }
  }

  const submit = (event: FormEvent) => { event.preventDefault(); void sendText(input) }
  const toggleMute = () => {
    setMuted((current) => !current)
    if (!muted) stopSpeaking()
  }

  return (
    <main className={`assistant-shell ${settings.motion ? "motion-on" : "motion-off"}`}>
      <header className="assistant-chrome">
        <Button variant="ghost" size="icon" className="chrome-button" onClick={() => setMenuOpen(true)} aria-label="Menü öffnen"><Menu /></Button>
        <div className="brand"><span className="brand-mark"><Sparkles /></span><span><strong>Avatar</strong> AI</span></div>
        <div className="chrome-actions">
          <button className="connection-pill" onClick={() => { setLoginTarget(provider); setOnboardingOpen(true) }} aria-label="Anbieter und Verbindung öffnen">
            <span className={`status-dot ${connected[provider] ? `tone-${tone}` : "offline"}`} />
            <span>{PROVIDERS[provider].name}</span>
          </button>
          <Button variant="ghost" size="icon" className="chrome-button" onClick={() => setChatOpen(true)} aria-label="Unterhaltung öffnen"><MessageCircle /></Button>
        </div>
      </header>

      <section
        className={`avatar-stage state-${avatarState} viseme-${viseme} gesture-${gesture}`}
        aria-label={`Avatar AI, Status: ${stateLabels[avatarState]}`}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          setGaze({
            x: Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - .5) * 2)),
            y: Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - .5) * 2)),
          })
        }}
        onPointerLeave={() => setGaze({ x: 0, y: 0 })}
        style={{ "--gaze-x": gaze.x, "--gaze-y": gaze.y } as CSSProperties}
      >
        <div className="ambient-field" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
        <div className="presence-ring ring-one" aria-hidden="true" />
        <div className="presence-ring ring-two" aria-hidden="true" />
        <div className="avatar-halo" aria-hidden="true" />

        <div className={`assistant-caption ${interim ? "user-live" : ""}`} aria-live="polite">
          <span>{interim ? "Du · live" : busy ? "Avatar AI" : stateLabels[avatarState]}</span>
          <p>{caption}</p>
        </div>

        <div className="avatar-presence">
          <div className="avatar-gesture">
            <div className="avatar-rig">
              <Image src="/assets/avatar-assistant.png" alt="Avatar AI, eine freundliche virtuelle Assistentin" width={1024} height={1536} priority unoptimized />
              <div className="face-rig" aria-hidden="true"><span className="mouth" /></div>
            </div>
          </div>
        </div>

        <div className="floor-light" aria-hidden="true" />
        <div className="voice-dock">
          <Button
            className={`mic-button ${avatarState === "listening" ? "active" : ""}`}
            size="icon-lg"
            disabled={busy}
            aria-label={avatarState === "listening" ? "Zuhören beenden" : "Mit Avatar AI sprechen"}
            onClick={avatarState === "listening" ? stopListening : startListening}
          >{avatarState === "listening" ? <MicOff /> : <Mic />}</Button>
          <div><strong>{stateLabels[avatarState]}</strong><span>{connected[provider] ? "Tippen und sprechen" : "OAuth-Anmeldung nötig"}</span></div>
          {busy
            ? <Button variant="ghost" size="icon" onClick={() => abortRef.current?.abort()} aria-label="Antwort stoppen"><CircleStop /></Button>
            : <Button variant="ghost" size="icon" onClick={toggleMute} aria-label={muted ? "Sprachausgabe aktivieren" : "Sprachausgabe stummschalten"}>{muted ? <VolumeX /> : <Volume2 />}</Button>}
        </div>
      </section>

      {notice && <div className="notice" role="status">{notice}</div>}

      <Sheet open={chatOpen} onOpenChange={setChatOpen}>
        <SheetContent side="right" className="assistant-sheet chat-sheet">
          <SheetHeader className="sheet-heading">
            <div className="sheet-kicker"><AudioLines /> Live-Dialog</div>
            <SheetTitle>Unterhaltung</SheetTitle>
            <SheetDescription>Sprich oder schreibe – die Antwort wird automatisch vorgelesen.</SheetDescription>
          </SheetHeader>
          <div className="sheet-tools">
            <Button variant="ghost" size="sm" onClick={toggleMute}>{muted ? <VolumeX /> : <Volume2 />}{muted ? "Ton an" : "Stumm"}</Button>
            <Button variant="ghost" size="sm" onClick={() => setMessages([welcome])}><Eraser /> Leeren</Button>
          </div>
          <div className="messages" ref={messagePane}>
            {messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
              <div className="message-meta"><span>{message.role === "assistant" ? "Avatar AI" : "Du"}</span><time>{clock(message.at)}</time></div>
              <p>{message.content}</p>
              {message.provider && message.role === "assistant" && <small className="model-chip">{PROVIDERS[message.provider].name}</small>}
            </article>)}
            {interim && <article className="message user interim"><div className="message-meta"><span>Du · live</span></div><p>{interim}</p></article>}
            {busy && <div className="thinking-row" role="status"><span /><span /><span /> {PROVIDERS[provider].name} formuliert eine Antwort</div>}
          </div>
          <form className="composer" onSubmit={submit}>
            <Textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendText(input) } }} placeholder="Nachricht an Avatar AI …" aria-label="Nachricht" rows={2} />
            <div className="composer-actions">
              {busy
                ? <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}><CircleStop /> Stoppen</Button>
                : <Button type="button" variant="ghost" onClick={avatarState === "listening" ? stopListening : startListening}><Waves /> Sprache</Button>}
              <Button type="submit" className="send-button" disabled={!input.trim() || busy}><Send /> Senden</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="assistant-sheet menu-sheet">
          <SheetHeader className="sheet-heading">
            <div className="sheet-kicker"><ShieldCheck /> Gerätelokal</div>
            <SheetTitle>Avatar AI</SheetTitle>
            <SheetDescription>Anbieter, Stimme und Verhalten verwalten.</SheetDescription>
          </SheetHeader>
          <section className="menu-section">
            <div className="menu-section-title"><span>KI-Anbieter</span><small>OAuth</small></div>
            <div className="menu-provider-list">
              {(Object.keys(PROVIDERS) as ProviderId[]).map((item) => {
                const meta = PROVIDERS[item]
                return <button className={`menu-provider ${provider === item ? "selected" : ""}`} key={item} onClick={() => chooseProvider(item)}>
                  <span className="provider-logo" style={{ "--provider-color": meta.color } as CSSProperties}>{meta.short}</span>
                  <span><strong>{meta.name}</strong><small>{connected[item] ? "Verbunden" : "Anmelden"}</small></span>
                  {connected[item] ? <Check className="provider-check" /> : <ChevronRight />}
                </button>
              })}
            </div>
            <div className="active-provider-card">
              <div><span className={`status-dot ${connected[provider] ? "tone-green" : "offline"}`} /><strong>{PROVIDERS[provider].name}</strong></div>
              <small>{model}</small>
              {connected[provider]
                ? <Button variant="ghost" size="sm" onClick={() => disconnect(provider)}><Unplug /> Trennen</Button>
                : <Button variant="outline" size="sm" onClick={() => { setLoginTarget(provider); setOnboardingOpen(true) }}><LogIn /> Mit OAuth anmelden</Button>}
            </div>
          </section>
          <section className="menu-section">
            <div className="menu-section-title"><span>Assistentin</span></div>
            <button className="menu-row" onClick={() => { setDraft(settings); setSettingsOpen(true) }}><Settings2 /><span><strong>Einstellungen</strong><small>Modelle, Sprache, Stimme, Bewegung</small></span><ChevronRight /></button>
            <button className="menu-row" onClick={toggleMute}>{muted ? <VolumeX /> : <Volume2 />}<span><strong>Sprachausgabe</strong><small>{muted ? "Stummgeschaltet" : "Automatisch vorlesen"}</small></span><ChevronRight /></button>
            <button className="menu-row" onClick={() => { setChatOpen(true); setMenuOpen(false) }}><MessageCircle /><span><strong>Unterhaltung</strong><small>{messages.length - 1} Nachrichten</small></span><ChevronRight /></button>
          </section>
          <div className="privacy-note"><ShieldCheck /><span><strong>Privat auf deinem Gerät</strong>Tokens liegen nur in der Sitzung; Avatar AI betreibt keinen eigenen Chat-Server.</span></div>
        </SheetContent>
      </Sheet>

      <Dialog open={onboardingOpen} onOpenChange={(open) => { if (open || hasConnection) setOnboardingOpen(open) }}>
        <DialogContent
          className="oauth-dialog"
          showCloseButton={hasConnection}
          onEscapeKeyDown={(event) => { if (!hasConnection) event.preventDefault() }}
          onPointerDownOutside={(event) => { if (!hasConnection) event.preventDefault() }}
        >
          <DialogHeader className="oauth-header">
            <div className="oauth-icon"><Sparkles /></div>
            <div><span className="eyebrow">Sicher starten</span><DialogTitle>Mit OAuth anmelden</DialogTitle><DialogDescription>Gemini ist voreingestellt. Avatar AI speichert weder Passwort noch dauerhaftes Zugangstoken.</DialogDescription></div>
          </DialogHeader>

          <div className="oauth-provider-tabs" role="tablist" aria-label="Anbieter wählen">
            {(Object.keys(PROVIDERS) as ProviderId[]).map((item) => <button role="tab" aria-selected={loginTarget === item} className={loginTarget === item ? "active" : ""} key={item} onClick={() => setLoginTarget(item)}>
              <span>{PROVIDERS[item].short}</span>{PROVIDERS[item].name.replace("Google ", "")}{item === "gemini" && <small>Standard</small>}
            </button>)}
          </div>

          {loginTarget === "gemini" && <section className="oauth-provider-panel">
            <div className="oauth-panel-title"><div className="provider-logo gemini-logo">G</div><div><strong>Google Gemini</strong><span>{DEFAULT_SETTINGS.geminiModel}</span></div></div>
            <p>Für den direkten Browser-Zugriff benötigt Google einmalig die nicht geheime OAuth-Web-Client-ID und die Cloud-Projekt-ID deiner App.</p>
            <div className="oauth-fields">
              <Label htmlFor="oauth-google-client">Google OAuth Web-Client-ID</Label>
              <Input id="oauth-google-client" autoComplete="off" placeholder="…apps.googleusercontent.com" value={draft.googleClientId} onChange={(event) => setDraft({ ...draft, googleClientId: event.target.value.trim() })} />
              <Label htmlFor="oauth-google-project">Google Cloud Projekt-ID</Label>
              <Input id="oauth-google-project" autoComplete="off" placeholder="mein-gemini-projekt" value={draft.googleProjectId} onChange={(event) => setDraft({ ...draft, googleProjectId: event.target.value.trim() })} />
            </div>
            <div className="oauth-help">
              <span><b>1</b> Generative Language API aktivieren</span><span><b>2</b> OAuth-Web-Client mit dieser Website als erlaubtem Ursprung anlegen</span>
              <a href="https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com" target="_blank" rel="noreferrer">Google Cloud öffnen <ExternalLink /></a>
            </div>
            <Button className="oauth-primary" disabled={!draft.googleClientId || !draft.googleProjectId} onClick={() => {
              const next = { ...draft }
              setSettings(next)
              saveSettings(next)
              void connect("gemini", next)
            }}><LogIn /> Mit Google OAuth anmelden</Button>
          </section>}

          {loginTarget === "openrouter" && <section className="oauth-provider-panel compact-panel">
            <div className="oauth-panel-title"><div className="provider-logo">OR</div><div><strong>OpenRouter</strong><span>{settings.openrouterModel}</span></div></div>
            <p>Die Anmeldung läuft direkt bei OpenRouter über OAuth mit PKCE. Es ist keine Client-ID in Avatar AI nötig.</p>
            <Button className="oauth-primary" onClick={() => void connect("openrouter")}><Link2 /> Mit OpenRouter verbinden</Button>
          </section>}

          {loginTarget === "huggingface" && <section className="oauth-provider-panel compact-panel">
            <div className="oauth-panel-title"><div className="provider-logo hf-logo">HF</div><div><strong>Hugging Face</strong><span>{settings.huggingfaceModel}</span></div></div>
            <p>Im Web wird die OAuth-App automatisch erkannt. Eine eigene Client-ID ist nur für manche lokale oder APK-Installationen nötig.</p>
            <Label htmlFor="oauth-hf-client">Hugging-Face Client-ID <span className="optional">optional</span></Label>
            <Input id="oauth-hf-client" placeholder="CIMD automatisch" value={draft.huggingfaceClientId} onChange={(event) => setDraft({ ...draft, huggingfaceClientId: event.target.value.trim() })} />
            <Button className="oauth-primary" onClick={() => {
              const next = { ...draft }
              setSettings(next)
              saveSettings(next)
              void connect("huggingface", next)
            }}><Link2 /> Mit Hugging Face verbinden</Button>
          </section>}

          <div className="oauth-privacy"><ShieldCheck /><span><strong>Direkte Verbindung</strong>Deine Nachricht geht direkt an den gewählten KI-Anbieter.</span></div>
          {hasConnection && <DialogFooter><Button variant="ghost" onClick={() => setOnboardingOpen(false)}>Zur Assistentin</Button></DialogFooter>}
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="settings-dialog">
          <DialogHeader><DialogTitle>Avatar AI einstellen</DialogTitle><DialogDescription>Modelle, Stimme und Verhalten. Die OAuth-App-IDs sind keine Geheimnisse.</DialogDescription></DialogHeader>
          <div className="settings-grid">
            <div className="settings-section"><h3>Modelle</h3>
              <Label htmlFor="or-model">OpenRouter</Label><Input id="or-model" value={draft.openrouterModel} onChange={(event) => setDraft({ ...draft, openrouterModel: event.target.value })} />
              <Label htmlFor="hf-model">Hugging Face</Label><Input id="hf-model" value={draft.huggingfaceModel} onChange={(event) => setDraft({ ...draft, huggingfaceModel: event.target.value })} />
              <Label htmlFor="g-model">Gemini</Label><Input id="g-model" value={draft.geminiModel} onChange={(event) => setDraft({ ...draft, geminiModel: event.target.value })} />
            </div>
            <div className="settings-section"><h3>OAuth-Konfiguration</h3>
              <Label htmlFor="hf-client">Hugging Face Client-ID <span>optional</span></Label><Input id="hf-client" placeholder="CIMD automatisch" value={draft.huggingfaceClientId} onChange={(event) => setDraft({ ...draft, huggingfaceClientId: event.target.value })} />
              <Label htmlFor="google-client">Google OAuth Web-Client-ID</Label><Input id="google-client" placeholder="…apps.googleusercontent.com" value={draft.googleClientId} onChange={(event) => setDraft({ ...draft, googleClientId: event.target.value })} />
              <Label htmlFor="google-project">Google Cloud Projekt-ID</Label><Input id="google-project" placeholder="mein-gemini-projekt" value={draft.googleProjectId} onChange={(event) => setDraft({ ...draft, googleProjectId: event.target.value })} />
            </div>
            <div className="settings-section settings-wide"><h3>Stimme & Bewegung</h3>
              <div className="setting-row"><div><Label>Sprache</Label><small>Erkennung und Ausgabe</small></div><Select value={draft.language} onValueChange={(value) => setDraft({ ...draft, language: value as "de-DE" | "en-US" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="de-DE">Deutsch</SelectItem><SelectItem value="en-US">English</SelectItem></SelectContent></Select></div>
              <div className="setting-row"><div><Label htmlFor="auto-speak">Antworten vorlesen</Label><small>Mit der Systemstimme</small></div><Switch id="auto-speak" checked={draft.autoSpeak} onCheckedChange={(value) => setDraft({ ...draft, autoSpeak: value })} /></div>
              <div className="setting-row"><div><Label htmlFor="motion">Live-Animationen</Label><small>Atmung, Blickkontakt, Gestik, Status und Lippensynchronität</small></div><Switch id="motion" checked={draft.motion} onCheckedChange={(value) => setDraft({ ...draft, motion: value })} /></div>
              {voices.length > 0 && <div className="setting-row voice-row"><div><Label>Stimme</Label><small>Verfügbare Systemstimmen</small></div><Select value={voiceName} onValueChange={setVoiceName}><SelectTrigger className="voice-select"><SelectValue placeholder="Stimme wählen" /></SelectTrigger><SelectContent>{voices.map((voice) => <SelectItem value={voice.name} key={`${voice.name}-${voice.lang}`}>{voice.name} · {voice.lang}</SelectItem>)}</SelectContent></Select></div>}
            </div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setDraft(DEFAULT_SETTINGS)}>Standardwerte</Button><Button className="send-button" onClick={saveConfig}>Speichern</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
