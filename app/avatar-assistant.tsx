"use client"

import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import Image from "next/image"
import { AudioLines, CircleStop, Eraser, Link2, Mic, MicOff, Send, Settings2, ShieldCheck, Sparkles, Unplug, Volume2, VolumeX, Waves } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
      callback(response: { access_token?: string; error?: string; error_description?: string }): void
      error_callback?(error: { type?: string }): void
    }): { requestAccessToken(options?: { prompt?: string }): void } } } }
  }
}

const welcome: Message = {
  id: "welcome",
  role: "assistant",
  content: "Hallo, ich bin Avatar AI. Verbinde einen Anbieter und sprich einfach mit mir – oder schreibe deine Nachricht.",
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

export function AvatarAssistant() {
  const [provider, setProvider] = useState<ProviderId>("openrouter")
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_SETTINGS)
  const [draft, setDraft] = useState<ProviderSettings>(DEFAULT_SETTINGS)
  const [messages, setMessages] = useState<Message[]>([welcome])
  const [input, setInput] = useState("")
  const [avatarState, setAvatarState] = useState<AvatarState>("idle")
  const [viseme, setViseme] = useState<Viseme>("sil")
  const [connected, setConnected] = useState<Record<ProviderId, boolean>>({ openrouter: false, huggingface: false, gemini: false })
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
  const canRecognize = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  const tone = useMemo(() => avatarState === "listening" ? "cyan" : avatarState === "thinking" ? "amber" : avatarState === "concerned" ? "rose" : avatarState === "idle" ? "green" : "blue", [avatarState])

  const refreshConnections = useCallback(() => setConnected({
    openrouter: Boolean(getToken("openrouter")),
    huggingface: Boolean(getToken("huggingface")),
    gemini: Boolean(getToken("gemini")),
  }), [])

  useEffect(() => {
    const value = loadSettings()
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setSettings(value)
      setDraft(value)
      refreshConnections()
    })
    void loadGoogleIdentity().catch(() => undefined)
    void finishOAuthFromLocation().then((result) => {
      if (!result) return
      setProvider(result)
      refreshConnections()
      setNotice(`${PROVIDERS[result].name} ist verbunden.`)
    }).catch((error: unknown) => setNotice(error instanceof Error ? error.message : "OAuth ist fehlgeschlagen."))
    return () => { active = false }
  }, [refreshConnections])

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

  useEffect(() => { messagePane.current?.scrollTo({ top: messagePane.current.scrollHeight, behavior: "smooth" }) }, [messages, interim])
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 4800)
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
      window.setTimeout(() => setAvatarState("idle"), 1100)
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
        cursor = Math.min(text.length - 1, cursor + Math.max(1, Math.round(text.length / 70)))
        setViseme(visemeAt(text, cursor))
      }, 90)
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
    if (!connected[provider]) { setNotice(`Verbinde zuerst ${PROVIDERS[provider].name}.`); return }
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
        setAvatarState("concerned")
        window.setTimeout(() => setAvatarState("idle"), 1500)
      }
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [busy, connected, messages, provider, settings, speak, stopSpeaking])

  const startListening = useCallback(() => {
    if (!canRecognize) { setNotice("Spracherkennung ist in diesem Browser nicht verfügbar. Das Textfeld funktioniert weiterhin."); return }
    stopSpeaking()
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Recognition) return
    const recognition = new Recognition()
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
      if (final) void sendText(transcript)
    }
    recognition.onerror = (event) => {
      if (event.error !== "no-speech") setNotice(`Mikrofon: ${event.error || "unbekannter Fehler"}`)
      setAvatarState("idle")
      setInterim("")
    }
    recognition.onend = () => { recognitionRef.current = null; setAvatarState((current) => current === "listening" ? "idle" : current) }
    recognitionRef.current = recognition
    setAvatarState("listening")
    recognition.start()
  }, [canRecognize, sendText, settings.language, stopSpeaking])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setAvatarState("idle")
    setInterim("")
  }, [])

  const connect = useCallback(async (target: ProviderId) => {
    setProvider(target)
    if (target !== "gemini") {
      try { await beginOAuth(target, settings) } catch (error) { setNotice(error instanceof Error ? error.message : "OAuth konnte nicht gestartet werden.") }
      return
    }
    if (!settings.googleClientId || !settings.googleProjectId) {
      setDraft(settings)
      setSettingsOpen(true)
      setNotice("Trage Google Client-ID und Projekt-ID ein, um Gemini zu verbinden.")
      return
    }
    try {
      await loadGoogleIdentity()
      if (!window.google) throw new Error("Google Identity ist nicht verfügbar.")
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: settings.googleClientId,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        callback: (response) => {
          if (!response.access_token) { setNotice(response.error_description || response.error || "Google OAuth ist fehlgeschlagen."); return }
          setToken("gemini", response.access_token)
          refreshConnections()
          setNotice("Google Gemini ist verbunden.")
        },
        error_callback: (error) => setNotice(`Google OAuth: ${error.type || "abgebrochen"}`),
      })
      client.requestAccessToken({ prompt: connected.gemini ? "" : "consent" })
    } catch (error) { setNotice(error instanceof Error ? error.message : "Google OAuth konnte nicht gestartet werden.") }
  }, [connected.gemini, refreshConnections, settings])

  const disconnect = (target: ProviderId) => {
    clearToken(target)
    refreshConnections()
    setNotice(`${PROVIDERS[target].name} wurde auf diesem Gerät getrennt.`)
  }
  const saveConfig = () => {
    setSettings(draft)
    saveSettings(draft)
    setSettingsOpen(false)
    setNotice("Einstellungen gespeichert.")
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void sendText(input) }

  return (
    <main className={`assistant-shell ${settings.motion ? "motion-on" : "motion-off"}`}>
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Sparkles /></span><span><strong>Avatar</strong> AI</span></div>
        <div className="top-status" aria-live="polite"><span className={`status-dot tone-${tone}`} />{stateLabels[avatarState]}<span className="top-model">{PROVIDERS[provider].name} · {model}</span></div>
        <Button variant="outline" size="sm" className="tech-button" onClick={() => { setDraft(settings); setSettingsOpen(true) }}><Settings2 /> Einstellungen</Button>
      </header>

      <section className="workspace">
        <aside className="provider-rail" aria-label="KI-Anbieter">
          <div className="panel-heading"><div><span className="eyebrow">OAuth</span><h2>Anbieter</h2></div><ShieldCheck /></div>
          <p className="panel-copy">Du meldest dich direkt beim Anbieter an. Tokens bleiben nur in dieser Sitzung.</p>
          <div className="provider-list">
            {(Object.keys(PROVIDERS) as ProviderId[]).map((item) => {
              const meta = PROVIDERS[item]
              return <article className={`provider-card ${provider === item ? "selected" : ""}`} key={item}>
                <button className="provider-select" onClick={() => setProvider(item)} aria-pressed={provider === item}>
                  <span className="provider-logo" style={{ "--provider-color": meta.color } as CSSProperties}>{meta.short}</span>
                  <span className="provider-name"><strong>{meta.name}</strong><small>{connected[item] ? "Verbunden" : "Nicht verbunden"}</small></span>
                  <span className={`connection-light ${connected[item] ? "online" : ""}`} />
                </button>
                <div className="provider-actions">{connected[item]
                  ? <Button variant="ghost" size="sm" onClick={() => disconnect(item)}><Unplug /> Trennen</Button>
                  : <Button variant="outline" size="sm" onClick={() => void connect(item)}><Link2 /> Mit OAuth verbinden</Button>}
                </div>
              </article>
            })}
          </div>
          <div className="privacy-note"><ShieldCheck /><span><strong>Gerätelokal</strong>Kein eigener Avatar-AI-Server speichert Chats oder Zugangsdaten.</span></div>
        </aside>

        <section
          className={`avatar-stage state-${avatarState} viseme-${viseme}`}
          aria-label={`Avatar, Status: ${stateLabels[avatarState]}`}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            setGaze({ x: Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - .5) * 2)), y: Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - .5) * 2)) })
          }}
          onPointerLeave={() => setGaze({ x: 0, y: 0 })}
          style={{ "--gaze-x": gaze.x, "--gaze-y": gaze.y } as CSSProperties}
        >
          <div className="stage-grid" /><div className="orbital orbital-one" /><div className="orbital orbital-two" /><div className="avatar-halo" />
          <div className="avatar-rig">
            <Image src="/assets/avatar-assistant.png" alt="Avatar AI, eine freundliche virtuelle Assistentin" width={1024} height={1536} priority unoptimized />
            <div className="face-rig" aria-hidden="true"><span className="brow brow-left" /><span className="brow brow-right" /><span className="lid lid-left" /><span className="lid lid-right" /><span className="pupil pupil-left" /><span className="pupil pupil-right" /><span className="mouth" /></div>
          </div>
          <div className="floor-light" />
          <div className="avatar-readout"><span className={`status-dot tone-${tone}`} /><div><strong>{stateLabels[avatarState]}</strong><small>Visem {viseme.toUpperCase()}</small></div><AudioLines /></div>
          <div className="voice-controls">
            <Button className={`mic-button ${avatarState === "listening" ? "active" : ""}`} size="icon-lg" aria-label={avatarState === "listening" ? "Zuhören beenden" : "Mit Avatar AI sprechen"} onClick={avatarState === "listening" ? stopListening : startListening}>{avatarState === "listening" ? <MicOff /> : <Mic />}</Button>
            <span>{avatarState === "listening" ? "Tippen zum Beenden" : "Tippen und sprechen"}</span>
          </div>
        </section>

        <section className="conversation-panel" aria-label="Unterhaltung">
          <div className="panel-heading conversation-heading"><div><span className="eyebrow">Live Dialog</span><h2>Unterhaltung</h2></div><div className="conversation-tools">
            <Button variant="ghost" size="icon-sm" aria-label={muted ? "Sprachausgabe aktivieren" : "Stummschalten"} onClick={() => { setMuted(!muted); if (!muted) stopSpeaking() }}>{muted ? <VolumeX /> : <Volume2 />}</Button>
            <Button variant="ghost" size="icon-sm" aria-label="Unterhaltung löschen" onClick={() => setMessages([welcome])}><Eraser /></Button>
          </div></div>
          <div className="messages" ref={messagePane}>
            {messages.map((message) => <article className={`message ${message.role}`} key={message.id}>
              <div className="message-meta"><span>{message.role === "assistant" ? "Avatar AI" : "Du"}</span><time>{clock(message.at)}</time></div>
              <p>{message.content}</p>{message.provider && message.role === "assistant" && <small className="model-chip">{PROVIDERS[message.provider].name}</small>}
            </article>)}
            {interim && <article className="message user interim"><div className="message-meta"><span>Du · live</span></div><p>{interim}</p></article>}
            {busy && <div className="thinking-row" role="status"><span /><span /><span /> {PROVIDERS[provider].name} formuliert eine Antwort</div>}
          </div>
          <form className="composer" onSubmit={submit}>
            <Textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendText(input) } }} placeholder="Nachricht an Avatar AI …" aria-label="Nachricht" rows={2} />
            <div className="composer-actions">{busy
              ? <Button type="button" variant="outline" onClick={() => abortRef.current?.abort()}><CircleStop /> Stoppen</Button>
              : <Button type="button" variant="ghost" onClick={avatarState === "listening" ? stopListening : startListening}><Waves /> Sprache</Button>}
              <Button type="submit" className="send-button" disabled={!input.trim() || busy}><Send /> Senden</Button>
            </div>
          </form>
        </section>
      </section>

      {notice && <div className="notice" role="status">{notice}</div>}

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="settings-dialog">
          <DialogHeader><DialogTitle>Avatar AI einstellen</DialogTitle><DialogDescription>Modelle und nicht geheime OAuth-App-IDs. Zugangstokens werden nie dauerhaft gespeichert.</DialogDescription></DialogHeader>
          <div className="settings-grid">
            <div className="settings-section"><h3>Modelle</h3>
              <Label htmlFor="or-model">OpenRouter</Label><Input id="or-model" value={draft.openrouterModel} onChange={(event) => setDraft({ ...draft, openrouterModel: event.target.value })} />
              <Label htmlFor="hf-model">Hugging Face</Label><Input id="hf-model" value={draft.huggingfaceModel} onChange={(event) => setDraft({ ...draft, huggingfaceModel: event.target.value })} />
              <Label htmlFor="g-model">Gemini</Label><Input id="g-model" value={draft.geminiModel} onChange={(event) => setDraft({ ...draft, geminiModel: event.target.value })} />
            </div>
            <div className="settings-section"><h3>OAuth-Konfiguration</h3>
              <Label htmlFor="hf-client">Hugging Face Client-ID <span>optional</span></Label><Input id="hf-client" placeholder="CIMD automatisch" value={draft.huggingfaceClientId} onChange={(event) => setDraft({ ...draft, huggingfaceClientId: event.target.value })} />
              <Label htmlFor="google-client">Google OAuth Client-ID</Label><Input id="google-client" placeholder="…apps.googleusercontent.com" value={draft.googleClientId} onChange={(event) => setDraft({ ...draft, googleClientId: event.target.value })} />
              <Label htmlFor="google-project">Google Cloud Projekt-ID</Label><Input id="google-project" placeholder="mein-gemini-projekt" value={draft.googleProjectId} onChange={(event) => setDraft({ ...draft, googleProjectId: event.target.value })} />
            </div>
            <div className="settings-section settings-wide"><h3>Stimme & Bewegung</h3>
              <div className="setting-row"><div><Label>Sprache</Label><small>Erkennung und Ausgabe</small></div><Select value={draft.language} onValueChange={(value) => setDraft({ ...draft, language: value as "de-DE" | "en-US" })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="de-DE">Deutsch</SelectItem><SelectItem value="en-US">English</SelectItem></SelectContent></Select></div>
              <div className="setting-row"><div><Label htmlFor="auto-speak">Antworten vorlesen</Label><small>Mit der Systemstimme</small></div><Switch id="auto-speak" checked={draft.autoSpeak} onCheckedChange={(value) => setDraft({ ...draft, autoSpeak: value })} /></div>
              <div className="setting-row"><div><Label htmlFor="motion">Live-Animationen</Label><small>Blick, Atmung, Blinzeln und Mimik</small></div><Switch id="motion" checked={draft.motion} onCheckedChange={(value) => setDraft({ ...draft, motion: value })} /></div>
              {voices.length > 0 && <div className="setting-row voice-row"><div><Label>Stimme</Label><small>Verfügbare Systemstimmen</small></div><Select value={voiceName} onValueChange={setVoiceName}><SelectTrigger className="voice-select"><SelectValue placeholder="Stimme wählen" /></SelectTrigger><SelectContent>{voices.map((voice) => <SelectItem value={voice.name} key={`${voice.name}-${voice.lang}`}>{voice.name} · {voice.lang}</SelectItem>)}</SelectContent></Select></div>}
            </div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setDraft(DEFAULT_SETTINGS)}>Standardwerte</Button><Button className="send-button" onClick={saveConfig}>Speichern</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
