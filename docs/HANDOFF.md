# ส่งงาน: รอบ MCP + capture + auth (31 ก.ค. 2026)

> **อัปเดตหลังรีสตาร์ตแล้ว (19:20 น.)** — ทดสอบบนเครื่องจริงไปแล้วส่วนใหญ่ ดูหัวข้อ
> "ผลทดสอบหลังรีสตาร์ต" ท้ายเอกสาร สิ่งที่ยังเหลือคือของฝั่งมือถือล้วน ๆ
> (HTTPS/PWA, voice, notification ตอนล็อกจอ)

เอกสารนี้เขียนไว้ให้ **session ถัดไปหลังรีสตาร์ต server** อ่านก่อนเริ่มงาน
งานทั้งหมดคอมมิตแล้วบนสาขา `tailscale-serve-scripts` แต่ **ยังไม่เคยรันจริงบน
server ตัวจริง** เพราะ session ที่ทำงานนี้อยู่ใน PTY ของ server ตัวนั้นเอง
รีสตาร์ตเมื่อไหร่ session จบทันที เลยทดสอบผ่านอินสแตนซ์แยก (พอร์ต 3099,
`HOME` คนละอัน) มาตลอด

## คอมมิตในรอบนี้

| commit | เรื่อง |
| --- | --- |
| `3b096a6` | เปลี่ยนปุ่มของ session ที่จบแล้วจาก "Relaunch" เป็น "New" ให้ตรงกับสิ่งที่มันทำ |
| `710a164` | MCP server + ช่องทาง Mac→มือถือ (notify/ask) + hook อนุมัติ + capture presets/Mac screen |
| `a81801c` | ปุ่ม Resume (`claude --continue`), เลิกสร้าง ghost session, ป้ายกำกับ capture, ปุ่มลัด URL |
| `f00e28c` | เอา token ออกจาก URL ทั้งหมด — ใช้ cookie สำหรับ WS handshake กับ `<img src>` |

รายละเอียดว่าแต่ละอย่างทำงานยังไงอยู่ใน `README.md` (Phase 7) และ `docs/MCP.md`

## ทดสอบอัตโนมัติ: รันก่อนอย่างอื่น

`scripts/smoke.mjs` ครอบ 36 อย่างที่มือถือพิสูจน์ให้ไม่ได้ (capture, notify/ask,
MCP, hook, auth, resume, ghost session) **ห้ามรันใส่ server ตัวจริง** — มันสร้าง
และฆ่า session สคริปต์จะปฏิเสธพอร์ต 3001 ให้เองอยู่แล้ว

```sh
npm run build
rm -rf /tmp/orbit-smoke && mkdir -p /tmp/orbit-smoke
HOME=/tmp/orbit-smoke ORBIT_PORT=3099 node server/dist/index.js &
HOME=/tmp/orbit-smoke ORBIT_PORT=3099 node scripts/smoke.mjs
```

ครั้งล่าสุด (31 ก.ค. 2026, ก่อนรีสตาร์ต): ผ่านครบ 36 ข้อ

## ทดสอบด้วยมือ: สิ่งที่สคริปต์พิสูจน์แทนไม่ได้

เรียงตามลำดับที่ควรทำ ข้อที่ทำเสร็จให้ขีดฆ่าในเอกสารนี้เลย

### 1. หลังรีสตาร์ต — สภาพเดิมยังอยู่ไหม

- [ ] เปิดมือถือ **ไม่ต้องใส่ token ใหม่** (token ไม่ได้เปลี่ยน แต่ต้อง reload
      หนึ่งครั้งเพื่อรับ bundle ใหม่ — bundle เก่ายังส่ง `?token=` ซึ่งถูกตัดไปแล้ว
      จะเด้งหน้า login ถ้าไม่ reload)
- [ ] แท็บ Sessions: session ที่เคยมีอยู่ใน Ended ครบ ประวัติเปิดอ่านได้
- [ ] เปิด session ใหม่ พิมพ์ภาษาไทยได้ปกติ (ระวัง regression ของ `ำ`)

### 2. Auth ไม่มี token ใน URL แล้ว

- [ ] รูปในแท็บ Captures ขึ้นครบ (ถ้า cookie ไม่ทำงาน รูปจะเป็นกรอบเปล่า)
- [ ] terminal ต่อติด (ถ้า cookie ไม่ทำงาน จะขึ้น Disconnected วนไปเรื่อย ๆ)
- [ ] ทดสอบผ่าน **HTTPS ของ tailscale** ด้วย (`npm run remote:on`) เพราะ cookie
      จะได้แฟล็ก `Secure` เฉพาะตอนนั้น — ทดสอบแต่ `http://<ip>:3001` ไม่ครอบเคสนี้
- [ ] เปิดแบบ PWA ที่ติดตั้งบนหน้าจอ (standalone) แล้วยังต่อได้ — WebKit จัดการ
      cookie ใน PWA คนละบริบทกับใน Safari ปกติ

### 3. Captures

- [ ] Desktop preset → ภาพกว้างเต็ม ไม่ถูกครอปเป็นกรอบมือถือ
- [ ] Full page ของหน้ายาว ๆ → thumbnail ไม่ยืดยาวเป็นเสา (ถูกคุมไว้ที่ 16:9)
- [ ] **Mac screen** → เห็นหน้าต่างแอปจริง ๆ ไหม ถ้าเห็นแต่ wallpaper กับ menu bar
      แปลว่ายังไม่ได้ให้สิทธิ์ Screen Recording (ดูข้อ setup ข้างล่าง — macOS
      ไม่ error ให้ ตรวจด้วยโค้ดไม่ได้)
- [ ] ปุ่มลัด URL โผล่หลัง capture สำเร็จ 2 URL ขึ้นไป

### 4. Resume — จุดที่เสี่ยงที่สุดในรอบนี้

ยังไม่เคยทดสอบกับบทสนทนาจริง (อินสแตนซ์ทดสอบใช้ `HOME` เปล่า ไม่มีบทสนทนาเก่า
เลยได้แค่พิสูจน์ว่ามันสั่ง `claude --continue` จริง)

- [ ] เปิด Claude Code ใน `orbit-demo` คุยสัก 2-3 ที → หยุด session → กด **↻ Resume**
      → **บทสนทนาเดิมกลับมาจริงไหม** (ถามว่า "เมื่อกี้เราคุยอะไรกัน")
- [ ] กด **＋ New** ในสถานการณ์เดียวกัน → ต้องเป็นบทสนทนาใหม่หมด
- [ ] Resume ในโฟลเดอร์ที่ไม่เคยคุย → ต้องขึ้น error ของ Claude เองใน terminal
      (ไม่ใช่ค้างหรือ session ตายเงียบ ๆ)
- [ ] ถ้าลง Codex CLI ไว้ ให้ลอง `codex resume --last` ด้วย — **ยังไม่เคยทดสอบเลย**
      ถ้า flag ผิดให้แก้ที่ `server/src/providers.ts` จุดเดียว

### 5. MCP (ต้อง setup ข้อ 2 ข้างล่างก่อน)

- [ ] ใน session ของ Claude: "capture http://localhost:5173 แบบ desktop แล้วบอกว่า
      layout พังตรงไหน" → agent ต้องเรียก `orbit_capture` เองและ**บรรยายภาพได้**
      (ถ้าบรรยายไม่ได้แปลว่ามันได้แค่ path ไม่ได้ภาพ)
- [ ] รูปที่ agent ถ่ายโผล่ในแท็บ Captures ของมือถือด้วย
- [ ] "ส่งข้อความบอกฉันเมื่อเสร็จ" → `orbit_notify` → toast ขึ้นบนมือถือ
- [ ] ล็อกหน้าจอมือถือ แล้วให้ agent เรียก `orbit_notify` → มี system notification
      ไหม (บน iOS ต้องเป็น PWA ที่ติดตั้งแล้ว + กดอนุญาต notification)
- [ ] `orbit_ask` → กล่องถามขึ้นบนมือถือ **และ agent หยุดรอจริง** จนกดตอบ
- [ ] `orbit_screen` → agent เห็น Simulator/แอป native ได้

### 6. Hook อนุมัติ (ต้อง setup ข้อ 3 ข้างล่างก่อน)

- [ ] สั่งให้ agent ลบอะไรสักอย่างด้วย `rm -rf` ในโฟลเดอร์ทดสอบ → กล่องเด้งบนมือถือ
      → กด **Block** → agent ต้องบอกว่าโดนปฏิเสธและไม่ลบ
- [ ] ทำซ้ำแล้วกด **Run it** → คำสั่งทำงานตามปกติ
- [ ] ปิด Orbit server แล้วใช้ Claude Code ตรง ๆ → ต้องไม่ถูกบล็อก (fail open)

### 7. ของเดิมที่ไม่ควรพัง

- [ ] voice input ภาษาไทย (ต้อง HTTPS)
- [ ] อัปโหลดรูปจากมือถือ → path แทรกลง terminal
- [ ] approval modal ของการ paste คำสั่งอันตราย (คนละตัวกับ hook)
- [ ] แถบคีย์ลัด + Ctrl + scroll pads
- [ ] ปิดจอ 5 นาทีระหว่าง agent ทำงานยาว → กลับมาแล้ว reconnect + replay ครบ

## สิ่งที่ผู้ใช้ต้องทำเอง (agent ทำแทนไม่ได้)

1. **รีสตาร์ต server** — `npm run build && npm start -w server` (หรือ `npm run dev`)
   agent ทำเองไม่ได้เพราะจะฆ่า session ตัวเอง หลังรีสตาร์ตแล้ว **reload หน้าเว็บบนมือถือ
   หนึ่งครั้ง**
2. ~~**ลงทะเบียน MCP**~~ — ลงแล้วที่ user scope (`claude mcp list` ขึ้น ✔ Connected)
   ชี้ไปที่ path เต็มของ `server/dist/mcp.js` ใช้ได้ทุกโฟลเดอร์ `.mcp.json` ใน repo
   ถูกลบออกแล้วเพราะซ้ำกัน
3. ~~**ติดตั้ง hook อนุมัติ**~~ — ลงแล้วใน `~/.claude/settings.json` เป็น PreToolUse
   ของ Bash พร้อม `"timeout": 190` (จำเป็น — ค่าเริ่มต้น 60 วิ จะตัด hook ทิ้งกลางทาง
   แล้วปล่อยคำสั่งผ่าน) ก่อนรีสตาร์ต server ตัวเก่ายังไม่มี `/api/ask` hook เลย
   ปล่อยผ่านทันทีใน ~40ms — ไม่มีอะไรพังระหว่างรอ
4. **สิทธิ์ Screen Recording** — System Settings → Privacy & Security → Screen &
   System Audio Recording → เปิดให้แอปที่รัน server (Terminal/iTerm/VS Code) แล้ว
   **ปิดเปิดแอปนั้นใหม่** เป็น GUI ล้วน agent แตะไม่ได้
5. **สิทธิ์ notification บนมือถือ** — ต้องกดอนุญาตบนเครื่องจริง และบน iOS ต้อง
   เป็น PWA ที่ Add to Home Screen แล้วเท่านั้น
6. **HTTPS ผ่าน Tailscale** — `npm run remote:on` จำเป็นสำหรับ voice, PWA,
   notification และการทดสอบแฟล็ก `Secure` ของ cookie
7. **ทดสอบบนมือถือจริง** — ทั้งหมดในหัวข้อ "ทดสอบด้วยมือ" ข้างบน agent ยิง
   headless Chrome แทนได้แค่บางส่วน แต่ Safari บน iOS มีพฤติกรรมของตัวเอง

## จุดที่รู้ตัวว่าอาจกวนใจ — ประเมินหลังใช้จริง

hook ที่ลงไว้เป็น user scope แปลว่ามันทำงานกับ **ทุก session ของ Claude Code**
ไม่ใช่แค่ที่สั่งจากมือถือ ถ้านั่งทำงานหน้าเครื่องโดยไม่ได้เปิด Orbit บนมือถือ แล้ว
agent สั่งคำสั่งที่เข้าข่ายอันตราย มันจะ**ค้างรอ 180 วินาทีแล้วค่อยปฏิเสธ**

ที่จงใจไม่ทำให้สั้นลงเพราะเคส "มือถือล็อกจออยู่" ก็หน้าตาเหมือนกันเป๊ะ (ไม่มี client
ต่ออยู่) และเคสนั้นคือหัวใจของฟีเจอร์ — หยิบมือถือขึ้นมาแล้วเห็นคำถามค้างรออยู่

ถ้าใช้จริงแล้วรำคาญ มีสามทางเลือก: ลด `TIMEOUT_SECONDS` ใน
`scripts/orbit-approve.mjs`, ย้าย hook ไปเป็น project scope เฉพาะโปรเจกต์ที่ทำจาก
มือถือ, หรือให้ server ตอบเร็วขึ้นเมื่อ**ไม่เคย**มีมือถือต่อเข้ามาเลยตั้งแต่บูต

## ของที่ยังค้าง (ไม่ได้ทำในรอบนี้)

- capture ไม่ผูกกับ session ที่เป็นต้นเหตุ — ตอนนี้มีแค่ป้ายบอก URL
- ไม่มีเพดานจำนวน session ที่เปิดพร้อมกัน
- วางข้อความทีละ ≤3 ตัวอักษรยังเลี่ยงด่าน approval ฝั่ง terminal ได้ (ฝั่ง agent
  hook ครอบให้แล้ว)
- Files/Diff tab, session timeline, layout สำหรับแท็บเล็ต — จาก roadmap เดิม

## ผลทดสอบหลังรีสตาร์ต (31 ก.ค. 19:00–19:25)

ผ่านแล้วบน server ตัวจริง:

- โค้ดใหม่ขึ้นครบ (`/api/presets`, cookie `HttpOnly; SameSite=Strict`)
- session ทั้ง 5 รอดข้ามรีสตาร์ต ประวัติครบ
- `orbit_capture` — agent สั่งเอง ได้ภาพจริงกลับมา รูปเข้าแกลเลอรีของมือถือด้วย
- `orbit_notify` — "Delivered to 1 connected phone" ขึ้น toast บนมือถือจริง
- `orbit_screen` — เห็นหน้าต่างแอปครบ (สิทธิ์ Screen Recording ให้ไว้แล้ว)
- hook — บล็อก `rm -rf` จากมือถือได้จริง พร้อมเหตุผลกลับถึง agent และปล่อยผ่าน
  เมื่อกด Run it (ทดสอบทั้งสองทาง)
- Resume — ต่อบทสนทนาได้จริง **แต่เจอ footgun** ดูข้างล่าง

**สิ่งที่เจอตอนทดสอบ Resume:** `claude --continue` เปิด "บทสนทนาล่าสุดของโฟลเดอร์"
ไม่ได้เปิด "บทสนทนาของ session ที่กด" — ทดสอบโดยกด Resume จาก session เก่า แล้วได้
บทสนทนาปัจจุบันขึ้นมาแทน (กลายเป็น agent ตัวที่สองในบทสนทนาเดียวกัน) แก้แล้วโดยให้
`resumable` เป็นจริงเฉพาะ session ที่จบล่าสุดของ cwd+provider นั้น และต้องไม่มี
session ไหนของโฟลเดอร์นั้นรันอยู่ — **การแก้นี้อยู่ใน dist แล้วแต่ต้องรีสตาร์ต server
อีกรอบถึงจะมีผล**

**ข้อควรระวังที่เพิ่งรู้จากการใช้จริง:** `orbit_screen` จับทุกอย่างที่อยู่บนจอ ตอน
ทดสอบมันจับ terminal ที่มี access token ของ Orbit พิมพ์อยู่ติดมาด้วย — ภาพนั้นเข้าไป
อยู่ในบริบทของ agent และในแกลเลอรี ปิดของที่ไม่อยากให้เห็นก่อนเรียก

ยังเหลือ (ฝั่งมือถือล้วน ๆ): HTTPS ผ่าน Tailscale + แฟล็ก `Secure` ของ cookie,
PWA แบบ standalone, voice ภาษาไทย, notification ตอนล็อกจอ, `codex resume --last`

## กติกาที่ควรรักษาไว้

- **ห้ามรีสตาร์ต หรือฆ่า server ที่พอร์ต 3001** ถ้า session ปัจจุบันรันอยู่ในนั้น —
  เช็คด้วย `curl -s -H "Authorization: Bearer <token>" localhost:3001/api/sessions`
  ว่ามี session ที่ `cwd` ตรงกับที่ทำงานอยู่และ `alive: true` ไหม
- ทดสอบอะไรที่แตะ `~/.orbit` ให้ใช้ `HOME` แยกเสมอ (`HOME=/tmp/orbit-smoke`)
- เก็บกวาด session/รูปที่สร้างตอนทดสอบเสมอ ไม่งั้นมันไปโผล่ในแกลเลอรีของผู้ใช้
