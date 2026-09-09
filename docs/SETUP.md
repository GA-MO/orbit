# ติดตั้ง Orbit บนเครื่องใหม่

คู่มือนี้สำหรับคนที่เพิ่งได้ repo มา และอยากให้ทุกอย่างทำงาน — terminal บนมือถือ,
tool ฝั่ง agent, และการแจ้งเตือนตอน Claude รอคุณ

**Orbit ไม่ใช่บริการกลางที่ทีมแชร์กัน** แต่ละคนรัน Orbit ของตัวเองบน Mac ตัวเอง
คุยกับ agent ของตัวเองผ่าน token ของตัวเอง ไม่มีอะไรวิ่งข้ามเครื่องกัน สิ่งที่แชร์กัน
คือ repo นี้เท่านั้น

## ต้องมีก่อน

| | ทำไม |
| --- | --- |
| macOS | Orbit รัน PTY จริงและจับหน้าจอ Mac |
| Bun 1.4+ | `bun -v` (ติดตั้ง: `curl -fsSL https://bun.sh/install | bash`) |
| Claude Code (`claude` บน PATH) | ตัวติดตั้งเรียก `claude mcp add` ให้ และ hook ก็เป็นของ Claude Code |
| Google Chrome | ใช้ตอน `orbit_capture` (ผ่าน `playwright-core`, ไม่โหลด browser เพิ่ม) |
| Tailscale (ทีหลังก็ได้) | จำเป็นตอนอยากใช้จากนอกบ้าน — [docs/TAILSCALE.md](TAILSCALE.md) |

## 1. ติดตั้ง

```sh
git clone <repo> orbit && cd orbit
make install
make setup
```

`make setup` ทำสามอย่าง แล้วบอกว่าแตะอะไรไปบ้าง:

1. `bun run build` — MCP server ต้องมีตัวจริงบนดิสก์ก่อนถึงจะลงทะเบียนได้
2. `claude mcp add -s user orbit` ชี้ไปที่ `server/dist/mcp.js` ของ checkout นี้
3. เขียน hook ลง `~/.claude/settings.json`

**path ทุกเส้นถูกหาจากตำแหน่งของ checkout เอง** ไม่มีอะไรให้แทนที่ด้วยมือ — นี่คือเหตุผล
ที่มีสคริปต์ตัวนี้ ก่อนหน้านี้เอกสารให้ก๊อป JSON แล้วแทน `/Users/<คุณ>/` เอง ซึ่งพลาดแล้ว
**ไม่มี error ให้เห็น** มีแต่ฟีเจอร์ที่เงียบไปเฉย ๆ

รันซ้ำได้เสมอ ปลอดภัย:

- ลบ hook ของ Orbit ทุกตัวออกก่อนเขียนชุดปัจจุบันกลับไป → รันสองครั้งไม่ได้ hook ซ้อน
  (hook ซ้อน = มือถือเด้งสองครั้งต่อหนึ่งคำถาม)
- **ย้าย checkout ไปโฟลเดอร์ใหม่แล้วรันอีกที คือวิธีซ่อม path** ไม่ใช่ต้องไปแก้ JSON เอง
- hook ของเครื่องมืออื่นในไฟล์เดียวกันไม่ถูกแตะ
- สำรอง `~/.claude/settings.json.orbit.bak` ก่อนเขียนทุกครั้ง
- ไฟล์ settings ที่ JSON พัง → หยุดพร้อมบอกเหตุผล ไม่ทับทิ้ง

## 2. เช็คว่าติดจริง

```sh
claude mcp list          # ต้องเห็น  orbit: …/.bun/bin/bun …/server/dist/mcp.js - ✔ Connected
```

หรือพิมพ์ `/mcp` ใน Claude Code

**session ที่เปิดค้างอยู่ยังไม่เห็นของใหม่** — MCP server ถูก spawn ตอน session เริ่ม
เท่านั้น ต้องเปิด session ใหม่ (ข้อนี้ใช้กับทุกครั้งที่แก้โค้ดใน `server/src/mcp.ts` ด้วย:
`bun run build` แล้วเปิด session ใหม่)

## 3. รันครั้งแรก

```sh
make phone       # build + start บน :3001 + เปิด Tailscale HTTPS ให้
```

console จะพิมพ์ `[orbit] access token: …` — เอาไปกรอกในหน้า login บนมือถือ
token เก็บที่ `~/.orbit/config.json` (อยากเปลี่ยน token ให้ลบเฉพาะ key `token` ในไฟล์ ไม่ใช่ลบทั้งไฟล์ เพราะไฟล์เดียวกันเก็บ push keypair ด้วย ลบทั้งไฟล์ = มือถือทุกเครื่องหลุดจาก push เงียบ ๆ)

ถ้ายังไม่ได้ตั้ง Tailscale ให้ใช้ `make mobile` (WiFi วงเดียวกัน) ไปก่อน — แต่ voice input
กับ Add to Home Screen ต้องการ HTTPS เพราะฉะนั้นสุดท้ายก็ต้องมี Tailscale

จบงานด้วย `make stop`

## สิ่งที่ติดมาให้ และแต่ละอันแก้ปัญหาอะไร

### MCP tools — ให้ agent เห็นงานตัวเองและเรียกหาคุณได้

`orbit_capture` (เห็นรูปของ UI ที่เพิ่งแก้), `orbit_screen` (เห็นหน้าจอ Mac),
`orbit_notify` (ส่งข้อความขึ้นมือถือ), `orbit_preview` (เปิดแอปจริงบนมือถือ),
`orbit_ask` (ถามแล้วรอคำตอบ) — รายละเอียดและข้อควรระวังอยู่ที่ [docs/MCP.md](MCP.md)

ทุก tool คุยกับ Orbit server บน `127.0.0.1:3001` เพราะฉะนั้น **server ต้องรันอยู่**
ไม่งั้น tool จะตอบว่าเชื่อมต่อไม่ได้ (แต่ session ไม่พัง)

### hook แจ้งเตือน — รู้ว่า Claude รออยู่

`AskUserQuestion`, `Notification`, `Stop` → `orbit hook notify`

กล่องคำถามของ Claude Code วาดอยู่ใน terminal เท่านั้น จากมือถือที่คว่ำอยู่บนโต๊ะ
มันหน้าตาเหมือน session ที่กำลังคิด และรอได้ทั้งคืน hook นี้ส่งจังหวะพวกนั้นขึ้นมือถือ
ส่งแบบ `quiet` — เปิด Orbit ดูอยู่จะไม่เด้งอะไรเลย

### hook อนุมัติ — คำสั่งอันตรายที่ agent รันเอง

`PreToolUse` matcher `Bash` → `orbit hook approve` พร้อม `"timeout": 190`

Orbit กรองคำสั่งอันตรายที่ *คุณ* พิมพ์ลง terminal อยู่แล้ว แต่คำสั่งที่ *agent* รันผ่าน
Bash tool ไม่ได้ผ่านด่านนั้น hook นี้ปิดช่องว่างนั้น เจอ pattern อันตราย (`rm -rf`,
`sudo`, `git push --force`, เขียนดิสก์ดิบ, fork bomb) → เด้งถามบนมือถือ **agent หยุดรอ**
สูงสุด 180 วินาที ไม่มีใครตอบ = ปฏิเสธ Orbit ไม่ได้รัน = ปล่อยผ่าน

`timeout: 190` คือบรรทัดที่ห้ามลืม — ค่าเริ่มต้นของ Claude Code ตัด hook ทิ้งที่ 60 วินาที
ตั้งสั้นกว่าที่ hook รอ แปลว่าคำสั่งอันตรายหลุดผ่าน**เงียบ ๆ** ตอนคุณยังไม่ทันกด
`make setup` ใส่ให้เสมอ

**ไม่อยากได้อันนี้?** ถอดออกได้โดยไม่กระทบตัวอื่น — ลบ group ที่ matcher เป็น `Bash`
ออกจาก `~/.claude/settings.json` แล้ว **อย่ารัน `make setup` อีก** เพราะมันจะใส่กลับมา
(ถ้าจะถอดถาวร ทางที่ถูกคือเพิ่ม flag ใน `orbit setup` — server/src/setup.ts)

## ถอนออก

```sh
make unsetup     # ลบ hook + unregister MCP
```

ไม่แตะ checkout, ไม่แตะ `~/.orbit` (session, token, screenshot ยังอยู่ครบ)
อยากล้างข้อมูลด้วยให้ลบ `~/.orbit` เอง

## เจอปัญหา

| อาการ | สาเหตุที่พบบ่อย |
| --- | --- |
| `/mcp` ไม่เห็น orbit | session เปิดค้างอยู่ก่อนติดตั้ง — เปิด session ใหม่ |
| tool ตอบ "not reachable on 127.0.0.1:3001" | server ไม่ได้รัน — `make phone` หรือ `make start` |
| มือถือไม่เด้งอะไรเลย | เปิด Orbit ค้างอยู่ = ตั้งใจให้เงียบ ลองปิดแอปแล้วทดสอบใหม่ |
| `orbit_screen` ได้ภาพไม่มีหน้าต่างแอป | ยังไม่ได้ให้สิทธิ์ Screen Recording — ดู [docs/MCP.md](MCP.md) หัวข้อสุดท้าย |
| `make setup` บอกว่าลงทะเบียนไม่ได้ | `claude` ไม่อยู่บน PATH |
| `make phone` บอกพอร์ต 3001 ไม่ว่าง | มี Orbit รันอยู่แล้ว — `make stop` ก่อน |

## ทดสอบว่าอะไรพัง

```sh
make test           # ทุก suite บน server ชั่วคราว พอร์ตของมันเอง ไม่แตะ ~/.orbit
make test-setup     # เฉพาะตัวติดตั้งนี้
```

ภาพในเอกสารก็สร้างใหม่ได้เหมือนกัน — `make shots` เดินแอปจริงบน server ชั่วคราวแล้วถ่าย
`docs/images/*.jpg` ใหม่ทั้งชุด จากนั้น `bun docs/site/build.mjs` ประกอบหน้าเว็บใหม่

`make test` **ไม่เคยแตะ :3001** และไม่แตะ `~/.orbit` ของจริง — มันสร้าง HOME ชั่วคราว
ให้ตัวเอง ถ้า run ถูก kill กลางทางแล้วเหลือขยะไว้ ใช้ `make test-clean` เก็บ

## Releasing

```sh
scripts/release.sh 0.2.0    # ตั้ง version ใน package.json ทั้งสอง, commit, tag v0.2.0, push
```

tag จะรัน `.github/workflows/release.yml`: build executable ทั้ง arm64 และ x64
แนบเข้า GitHub Release พร้อม `.sha256` ข้างละไฟล์ จากนั้น `install.sh`
บนเครื่องไหนก็ได้จะดึงเวอร์ชันล่าสุดนี้ไปติดตั้ง

Homebrew เป็นทางเลือก: ถ้าตั้ง repository variable `TAP_REPO`
(`<owner>/homebrew-tap`) และ secret `TAP_TOKEN` ที่ push ไป tap นั้นได้
job `tap` จะเขียน `Formula/orbit.rb` ให้เองจาก `packaging/homebrew/orbit.rb.tmpl`
ไม่ตั้งก็ใช้ `scripts/tap.sh v0.2.0 ../homebrew-tap` ทำมือ
