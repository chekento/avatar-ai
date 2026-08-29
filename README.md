# Avatar AI

[![Build HTML and Android APK](https://github.com/chekento/avatar-ai/actions/workflows/build-release.yml/badge.svg)](https://github.com/chekento/avatar-ai/actions/workflows/build-release.yml)

Eine eigenständige, animierte KI-Assistentin für Browser und Android. Sie hört zu, antwortet per Stimme und animiert Blick, Blinzeln, Mimik sowie 15 mundbasierte Viseme synchron zur Ausgabe.

## Varianten

- [`dist/AvatarAI.html`](dist/AvatarAI.html) – portable Einzeldatei mit eingebettetem Avatar
- [`dist/AvatarAI-debug.apk`](dist/AvatarAI-debug.apk) – installierbare, CI-geprüfte Android-Debug-APK
- `android/` – natives Android-Projekt; lädt dieselbe Einzeldatei in einer abgesicherten App-Oberfläche
- `app/` – installierbare Web-App/Website mit der React-Oberfläche

Die geprüften Dateien liegen direkt unter `dist/`. Ein manuell gestarteter Main-Workflow aktualisiert zusätzlich das GitHub-Prerelease `dev-latest`.

## Unterstützte Anbieter

| Anbieter | Standardmodell | Anmeldung |
|---|---|---|
| OpenRouter | `~openai/gpt-latest` | OAuth mit PKCE; keine eigene Client-ID nötig |
| Hugging Face | `openai/gpt-oss-120b:fastest` | OAuth/OIDC mit PKCE und `inference-api` |
| Google Gemini | `gemini-3.7-flash` | Google OAuth, Cloud-Projekt und Generative Language API |

Avatar AI besitzt keinen Proxy-Server und verlangt keinen fest eingebauten API-Schlüssel. Im Browser liegen OAuth-Tokens ausschließlich im Sitzungsspeicher. Android verschlüsselt sie per AES-GCM mit einem Schlüssel aus dem Android Keystore.

## Lokal starten

```bash
npm ci
npm run dev
```

Für die portable HTML-Datei:

```bash
npm run build:standalone
python3 -m http.server 8080 --directory dist
```

OAuth funktioniert nicht direkt aus einer `file://`-Adresse. Öffne die HTML-Datei über HTTPS oder `http://localhost:8080/AvatarAI.html`.

## OAuth einrichten

### OpenRouter

Direkt auf „Mit OAuth verbinden“ klicken. Avatar AI erzeugt einen PKCE-Verifier und tauscht den Rückgabecode im Browser gegen den benutzergebundenen OpenRouter-Key.

### Hugging Face

Die gehostete Web-App veröffentlicht unter `/.well-known/oauth-cimd` automatisch ihre öffentlichen OAuth-Metadaten. Alternativ kann in den Einstellungen eine eigene öffentliche Hugging-Face-Client-ID eingetragen werden.

Für die APK eine öffentliche Client-ID ohne Secret anlegen, den Scope `inference-api` erlauben und `avatarai://oauth/huggingface` als exakte Redirect-URI registrieren.

### Google Gemini

1. In einem Google-Cloud-Projekt die Generative Language API aktivieren.
2. OAuth-Zustimmungsbildschirm konfigurieren.
3. Für die Website eine Web-Client-ID erstellen und die Web-Adresse als autorisierten JavaScript-Ursprung eintragen.
4. Google Client-ID und Cloud-Projekt-ID in Avatar AI unter „Einstellungen“ eintragen.

Die APK verwendet Authorization Code + PKCE und `avatarai://oauth/gemini`. Dieser Redirect muss zum gewählten öffentlichen/native OAuth-Client passen. Client-IDs und Projekt-IDs sind Konfiguration, keine Geheimnisse.

## Android bauen

Voraussetzungen: JDK 17, Android SDK 36, Build Tools 36.0.0 und Gradle 9.5.

```bash
npm run build:standalone
gradle -p android :app:assembleDebug
```

Die APK liegt danach unter `android/app/build/outputs/apk/debug/app-debug.apk`. Der GitHub-Workflow führt denselben Build automatisch aus und veröffentlicht die geprüfte Kopie als `dist/AvatarAI-debug.apk`.

## Datenschutz und Grenzen

- Chats bleiben im Arbeitsspeicher der laufenden Oberfläche.
- Browser-Tokens verschwinden beim Schließen der Sitzung; Android-Tokens lassen sich pro Anbieter trennen.
- Spracheingabe und Sprachausgabe verwenden die Dienste des Browsers beziehungsweise des Android-Geräts.
- Modellverfügbarkeit, Kosten und Datenverarbeitung richten sich nach dem gewählten Anbieter und Konto.

## Tests

```bash
npm test
```

Der Test baut die Website, erzeugt die Einzel-HTML, prüft ihre eingebetteten Bestandteile und validiert die ausgelieferte App-Shell.
