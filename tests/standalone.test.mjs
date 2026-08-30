import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

test("standalone build is self-contained and exposes all providers", async () => {
  const html = await readFile(new URL("../dist/AvatarAI.html", import.meta.url), "utf8")
  assert.doesNotMatch(html, /__AVATAR_DATA__/)
  assert.match(html, /data:image\/png;base64,/)
  assert.match(html, /OpenRouter/)
  assert.match(html, /Hugging Face/)
  assert.match(html, /Google Gemini/)
  assert.match(html, /v-oh/)
  assert.match(html, /v-ou/)
  assert.match(html, /provider="gemini"/)
  assert.match(html, /showOAuth\("gemini"\)/)
  assert.doesNotMatch(html, /class="(?:pupil|lid|brow)/)
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]).filter(Boolean)
  assert.equal(scripts.length, 1)
  scripts.forEach((script) => new Function(script))
})
