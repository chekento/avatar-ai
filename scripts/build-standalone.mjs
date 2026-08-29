import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const template = await readFile(resolve(root, "standalone/AvatarAI.template.html"), "utf8")
const portrait = await readFile(resolve(root, "public/assets/avatar-assistant.png"))
const output = template.replace("__AVATAR_DATA__", `data:image/png;base64,${portrait.toString("base64")}`)

for (const target of ["dist/AvatarAI.html", "android/app/src/main/assets/AvatarAI.html"]) {
  const path = resolve(root, target)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, output)
  console.log(`wrote ${target}`)
}
