# ให้ agent ใช้ Orbit ได้เอง (MCP + hook อนุมัติ)

ปกติ Orbit คือ **มือถือสั่ง Mac** — คุณเป็นคนกด capture, คุณเป็นคนแปะ path ให้ agent
เอกสารนี้คือทางกลับกัน: ให้ agent ที่รันอยู่ใน session ของ Orbit **มองเห็นงานตัวเอง**
และ **เรียกหาคุณ** ได้ ผ่าน MCP server ที่มากับ Orbit

| Tool | ทำอะไร |
| --- | --- |
| `orbit_capture` | render เว็บที่รันอยู่แล้ว **เห็นภาพเลย** (ไม่ใช่ path) — รูปโผล่ในแท็บ Captures บนมือถือด้วย |
| `orbit_screen` | จับหน้าจอ Mac จริง — Simulator, Xcode, แอป native ที่ headless Chrome เห็นไม่ได้ |
| `orbit_notify` | ส่งข้อความสั้นขึ้นมือถือ เช่น "งานเสร็จแล้ว" |
| `orbit_ask` | ถามคำถามขึ้นมือถือ **แล้วรอ** จนกว่าจะกดตอบ |

ทั้งหมดคุยกับ Orbit server ที่พอร์ต 3001 ผ่าน token ใน `~/.orbit/config.json`
เพราะฉะนั้น **server ต้องรันอยู่** ไม่งั้น tool จะตอบกลับว่าเชื่อมต่อไม่ได้

## ติดตั้ง

```sh
npm run build              # ต้อง build ก่อน — MCP server อยู่ที่ server/dist/mcp.js
claude mcp add -s user orbit -- node /Users/<คุณ>/Development/orbit/server/dist/mcp.js
```

`-s user` ทำให้ใช้ได้ทุกโปรเจกต์ (เช่นตอนเปิด session ใน `orbit-demo`) ไม่ใช่แค่ใน repo นี้
เช็คด้วย `claude mcp list` หรือพิมพ์ `/mcp` ใน Claude Code

ในตัว repo นี้มี `.mcp.json` ให้อยู่แล้ว — session ที่เปิดที่โฟลเดอร์ orbit จะเห็น tools
เลยหลัง build (Claude Code จะถามยืนยันครั้งแรก)

### ลองใช้

```
capture http://localhost:5173 แบบ desktop แล้วบอกหน่อยว่า layout พังตรงไหน
```

agent จะเรียก `orbit_capture` เอง เห็นรูปเอง และคุณเห็นรูปเดียวกันในแท็บ Captures

## hook อนุมัติคำสั่งอันตราย

Orbit กรองคำสั่งอันตรายที่ **คุณ** พิมพ์/วางลง terminal อยู่แล้ว แต่คำสั่งที่ **agent
รันเอง** ผ่าน Bash tool ไม่ได้ผ่านด่านนั้นเลย — มันรันอยู่ในโปรเซสของ agent ไม่ได้ถูก
พิมพ์เข้า PTY hook ตัวนี้ปิดช่องว่างนั้นด้วยชุด pattern เดียวกัน (`rm -rf`, `sudo`,
`git push --force`, เขียนดิสก์ดิบ, fork bomb, …)

ใส่ใน `.claude/settings.json` ของโปรเจกต์ (หรือ `~/.claude/settings.json` ถ้าอยากให้ทุกที่):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/<คุณ>/Development/orbit/scripts/orbit-approve.mjs"
          }
        ]
      }
    ]
  }
}
```

พฤติกรรม:

- คำสั่งธรรมดา → เงียบ ปล่อยผ่านตามระบบ permission ปกติของ Claude Code
- คำสั่งอันตราย → เด้งถามบนมือถือ **agent หยุดรอ** สูงสุด 180 วินาที
- กด **Block** (ปุ่มเด่น — ตัวเลือกแรกคือตัวเลือกที่ปลอดภัยเสมอ) → คำสั่งถูกปฏิเสธ
  พร้อมเหตุผลกลับไปหา agent
- ไม่มีใครตอบ / ไม่มีมือถือต่ออยู่ → **ปฏิเสธ** (fail closed)
- Orbit server ไม่ได้รัน → **ปล่อยผ่าน** (fail open) เพื่อไม่ให้ Claude Code พังตอนใช้ปกติ

## Screen Recording สำหรับ `orbit_screen`

macOS ต้องได้รับอนุญาตก่อนถึงจะเห็น "หน้าต่างของแอป" ในภาพที่จับได้ — และจุดที่หลอกคือ
**ถ้าไม่ได้รับอนุญาต มันจะไม่ error** แต่จะได้ภาพ desktop + menu bar ที่ไม่มีหน้าต่างใด ๆ เลย

ถ้าภาพที่ได้ไม่มีหน้าต่างแอป: System Settings → Privacy & Security → Screen & System Audio
Recording → เปิดให้ **แอปที่รัน Orbit server** (Terminal, iTerm, VS Code — แล้วแต่ว่าคุณ
`npm start` จากตัวไหน) แล้วรีสตาร์ทแอปนั้น

## ข้อควรรู้

- `orbit_ask` มีตัวจับเวลา (ค่าเริ่มต้น 120 วินาที) หมดเวลาแล้ว agent จะได้รับแจ้งว่า
  ไม่มีใครตอบ — และถูกบอกไม่ให้ตีความว่าอนุมัติ
- ภาพที่กว้างเกิน 1568px จะถูกย่อก่อนส่งให้ agent (ไฟล์ต้นฉบับบนดิสก์ยังเต็มขนาด)
- คำถามที่ค้างอยู่จะถูกส่งซ้ำให้มือถือที่เพิ่งต่อเข้ามา — ล็อกจอไปแล้วเปิดกลับมาก็ยังเห็น
