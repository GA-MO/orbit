# คู่มือการใช้งาน Orbit

Orbit เปลี่ยน MacBook ของคุณเป็น AI development server ส่วนตัว — สั่งงาน Claude Code
จากมือถือได้เหมือนนั่งอยู่หน้าเครื่อง คู่มือนี้พาเดินครบทุกฟีเจอร์ด้วยตัวอย่างจริง:
สร้างเว็บเดโม่เล็ก ๆ รัน dev server ตรวจงานด้วย screenshot และคุยกับ Claude Code
ทั้งหมดจากหน้าจอมือถือ

> ภาพประกอบทั้งหมดถ่ายจากการใช้งานจริงบน viewport ขนาด iPhone (390×844)

## เริ่มต้น: จับคู่กับ Mac

รัน server บน Mac (`npm run build && npm start -w server`) แล้วเปิดจากมือถือ
ครั้งแรกจะเจอหน้า login ใส่ access token ที่ server พิมพ์ไว้ใน console
(`[orbit] access token: …`) ใส่ครั้งเดียว เครื่องจะจำไว้

เข้าได้ 2 ทาง:

| ทาง | URL | ข้อจำกัด |
|---|---|---|
| **HTTPS ผ่าน Tailscale** (แนะนำ) | `https://<เครื่อง>.<tailnet>.ts.net` | ใช้ได้ทุกฟีเจอร์ + เข้าจากนอกบ้านได้ ตั้งครั้งเดียวตาม [TAILSCALE.md](TAILSCALE.md) |
| LAN ธรรมดา | `http://<ip-ของ-mac>:3001` | ต้องอยู่ WiFi วงเดียวกัน และ **สั่งงานด้วยเสียงกับ Add to Home Screen จะใช้ไม่ได้** |

ที่เสียงใช้ไม่ได้บน HTTP เพราะเบราว์เซอร์ยอมให้ขอไมค์และลงทะเบียน service worker
เฉพาะบน secure context (HTTPS) เท่านั้น — ไม่ใช่ข้อจำกัดของ Orbit เอง

<img src="images/01-login.png" width="390" alt="หน้า login ใส่ access token">

## แท็บ Terminal: shell จริงบนมือถือ

เข้ามาแล้วเจอ terminal ที่ต่อกับ zsh บน Mac ตรง ๆ — สี ANSI, prompt theme,
Ctrl+C, interactive TUI ทำงานครบ header บอกว่ากำลังอยู่ session ไหน
โฟลเดอร์อะไร สถานะเชื่อมต่อ (วงแหวน orbit หมุน = เชื่อมต่ออยู่)

ในภาพ: สร้างโปรเจกต์ `orbit-demo` เขียน `index.html` แล้วรัน
`python3 -m http.server 4321` — ทั้งหมดพิมพ์จากมือถือ

<img src="images/02-terminal.png" width="390" alt="terminal รัน dev server">

> 💡 **Session ไม่ตายเมื่อจอดับ** — ปิดเบราว์เซอร์ สลับแอป หรือเน็ตหลุด
> กลับมาแล้ว shell ยังรันต่ออยู่พร้อมประวัติครบ

## แท็บ Sessions: ศูนย์ควบคุม

เห็นทุก session ในที่เดียว — จุดสีเหลืองกระพริบ = กำลังรันอยู่
แต่ละแถวบอก agent, โฟลเดอร์, อายุ ตั้งชื่อ session ได้ (✎)
เพื่อแยกว่าตัวไหนทำงานอะไร เช่น "demo server" กับ "demo feature"

<img src="images/09-sessions.png" width="390" alt="รายการ sessions">

- **แตะแถว** — สลับไป session นั้น
- **✎** — เปลี่ยนชื่อ
- **🗑 (session ที่รันอยู่)** — หยุด ประวัติถูกเก็บไว้ในหมวด Ended
- **↻ (session ที่จบแล้ว)** — เปิดใหม่ด้วย agent + โฟลเดอร์ + ชื่อเดิม
- **🗑 (session ที่จบแล้ว)** — ลบถาวรพร้อมประวัติ

## สร้าง session ใหม่

กดปุ่ม **+** ในแท็บ Sessions:

1. **เลือก agent** — การ์ดจะจางถ้ายังไม่ได้ติดตั้ง CLI ตัวนั้น
2. **ตั้งชื่อ** (ไม่บังคับ แต่ช่วยมากเมื่อเปิดหลายตัว)
3. **เลือกโฟลเดอร์โปรเจกต์** — recent projects กดแตะเดียว หรือ browse เอง
   (โฟลเดอร์ที่เป็น git repo มีสัญลักษณ์ branch สีเขียว, ช่อง filter โผล่เมื่อ
   โฟลเดอร์เยอะ) ถ้าเผลอเลือกโฟลเดอร์กว้าง ๆ อย่าง home จะมีคำเตือนสีเหลือง
   แต่ไม่ห้าม

<img src="images/05-new-session.png" width="390" alt="สร้าง session ใหม่">

## ใช้ Claude Code จากมือถือ

เลือกการ์ด Claude Code + โฟลเดอร์โปรเจกต์ → ได้ Claude Code ตัวจริงรันบน Mac
ในภาพ: session "demo feature" ใน `orbit-demo` สลับโมเดลด้วย `/model haiku`
แล้วส่งพรอมป์ตทดสอบ — คำตอบกลับมาแสดงบนมือถือครบถ้วน

<img src="images/06-claude-code.png" width="390" alt="Claude Code ตอบพรอมป์ตผ่านมือถือ">

## สั่งงานด้วยเสียง 🎙

ปุ่มไมค์บน header ของ terminal → พูด → transcript ขึ้นสด **แก้ข้อความได้ก่อนส่ง**

> ⚠️ ต้องเข้าผ่าน **HTTPS** เท่านั้น ถ้าเปิดด้วย `http://<ip-ของ-mac>:3001`
> เบราว์เซอร์จะไม่ยอมให้ขอไมค์ ดู [TAILSCALE.md](TAILSCALE.md)

- **Insert** — พิมพ์ข้อความลง terminal เฉย ๆ (ตรวจก่อนกด Enter เอง)
- **Send ⏎** — พิมพ์แล้วส่งทันที

<img src="images/07-voice.png" width="390" alt="voice input พร้อม transcript">

## ส่งภาพให้ agent 🖼

ปุ่มรูปภาพบน header → เลือกรูป/ถ่ายภาพ (เช่น screenshot ของ error หรือ
design ที่อยากได้) → ไฟล์ถูกอัปโหลดไปเก็บบน Mac แล้ว **path ถูกพิมพ์ลง
terminal ให้เลย** — พิมพ์ต่อว่าอยากให้ Claude ทำอะไรกับภาพนั้นได้ทันที

## แท็บ Captures: ตรวจงานด้วยตา

Agent แก้เว็บให้แล้ว — หน้าตาเป็นยังไง? ใส่ URL ของ dev server แล้วกด
**Capture**: Mac จะเปิด Chrome แบบ headless, render ที่ขนาดจอ iPhone
(หรือติ๊ก Full page) แล้วเก็บภาพไว้ในแกลเลอรี

ในภาพ: หน้าเว็บ `orbit-demo` ที่เพิ่งสร้างผ่าน terminal เมื่อครู่

<img src="images/03-captures.png" width="390" alt="แท็บ captures">

แตะภาพเพื่อดูเต็มจอ / **⇥** แทรก path ของภาพลง terminal เพื่อส่งให้ agent
ดูต่อ ("ทำไมปุ่มเบี้ยว ดูจากภาพนี้") / **🗑** ลบ

<img src="images/04-capture-viewer.png" width="390" alt="ดูภาพเต็มจอ">

## เกราะป้องกัน: Command Approval

Input ที่มาเป็นก้อน (วางข้อความ, สั่งด้วยเสียง) ถูกตรวจกับ pattern อันตราย
เช่น `rm -rf`, `sudo`, format disk, force push — ถ้าเจอ คำสั่งจะถูก**ยึดไว้ก่อน**
และถามยืนยันบนจอ พร้อมแสดงคำสั่งเต็ม ๆ ให้อ่าน

<img src="images/08-approval.png" width="390" alt="modal ยืนยันคำสั่งอันตราย">

กด **Deny** = ทิ้งคำสั่ง ไม่มีอะไรถึง shell / **Run anyway** = ปล่อยผ่าน
(การพิมพ์สดทีละตัวอักษรไม่ถูกตรวจ — มือคุณ ความรับผิดชอบคุณ)

## ประวัติไม่หาย: Ended sessions

Session ที่จบแล้ว (agent ออกเอง, กดหยุด, หรือ server restart) ยังเปิดดูได้ —
terminal แสดงประวัติทั้งหมดแบบ **read-only** พร้อมป้ายบอกใน header
อยากทำงานต่อ กด ↻ ในแท็บ Sessions เพื่อเปิดตัวใหม่ที่เดิม

<img src="images/10-ended-readonly.png" width="390" alt="ดูประวัติ session ที่จบแล้วแบบ read-only">

## ติดตั้งเป็นแอป (PWA)

เปิดผ่าน HTTPS (ดู [TAILSCALE.md](TAILSCALE.md)) แล้ว **Add to Home Screen**
— ได้ไอคอน Orbit บนหน้าจอ เปิดเต็มจอไม่มีแถบเบราว์เซอร์

## สรุป flow ที่ใช้บ่อย

| อยากทำ | ทำยังไง |
|---|---|
| สั่ง Claude แก้โค้ดโปรเจกต์ X | Sessions → + → Claude Code → เลือก X → Start |
| ดูว่าเมื่อกี้ agent ทำอะไรไป | Sessions → แตะ session (จบแล้วก็เปิดดูได้) |
| ตรวจหน้าเว็บหลัง agent แก้ | Captures → ใส่ URL → Capture |
| ส่ง error screenshot ให้ agent | Terminal → 🖼 → เลือกรูป → พิมพ์คำสั่งต่อท้าย path |
| สั่งงานยาว ๆ ไม่อยากพิมพ์ | Terminal → 🎙 → พูด → แก้ transcript → Send |
| เปลี่ยนชื่อ session | Sessions → ✎ |
| หยุดทุกอย่างชั่วคราว | ปิดเบราว์เซอร์ไปเลย — ทุก session รอต่ออยู่บน Mac |
