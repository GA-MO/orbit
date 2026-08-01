# ใช้ Orbit นอกบ้านด้วย Tailscale

คู่มือนี้ทำให้คุณเปิด Orbit จากมือถือได้**จากทุกที่** (4G/5G, WiFi ร้านกาแฟ) โดยไม่ต้อง
เปิดพอร์ต ไม่ต้องตั้ง DDNS และไม่มีอะไรโผล่สู่อินเทอร์เน็ตสาธารณะ — Tailscale สร้าง
เครือข่ายส่วนตัว (tailnet) ระหว่างอุปกรณ์ของคุณผ่าน WireGuard และแผนส่วนตัวใช้ฟรี

```
iPhone/Android ──(WireGuard tunnel)── MacBook
   Tailscale app                        Tailscale + Orbit server
```

## 1. ติดตั้งบน Mac

ทางใดทางหนึ่ง:

- ดาวน์โหลดจาก https://tailscale.com/download (แนะนำ), หรือ
- `brew install --cask tailscale-app`, หรือ Mac App Store

เปิดแอป → **Log in** (Google/Apple/GitHub account อะไรก็ได้ — account นี้คือ "เจ้าของ tailnet")
ไอคอน Tailscale จะขึ้นบน menu bar เมื่อเชื่อมต่อแล้ว

## 2. ติดตั้งบนมือถือ

ลง **Tailscale** จาก App Store / Play Store → login ด้วย **account เดียวกัน** → เปิดสวิตช์ VPN

เท่านี้อุปกรณ์ทั้งสองก็มองเห็นกันแล้ว ตรวจสอบบน Mac:

```sh
tailscale status        # เห็นรายชื่ออุปกรณ์ + IP 100.x.y.z ของแต่ละเครื่อง
```

## 3. เปิด Orbit แบบ production

```sh
npm run build
npm start -w server     # จด access token ที่พิมพ์ใน console
```

จากมือถือ (เปิด Tailscale VPN อยู่) เข้า:

```
http://<tailscale-ip-ของ-mac>:3001     เช่น http://100.101.102.103:3001
```

หรือใช้ชื่อ MagicDNS แทน IP: `http://<ชื่อเครื่อง>.<tailnet>.ts.net:3001`

ใส่ access token ครั้งเดียว ใช้ได้เลย

## 4. อัปเกรดเป็น HTTPS ด้วย `tailscale serve` (แนะนำ)

HTTP ธรรมดาใช้งานได้ แต่ **service worker ของ PWA ต้องการ secure context** —
ผ่าน `http://100.x…` เบราว์เซอร์จะไม่ลงทะเบียน SW (offline shell หายไป)
`tailscale serve` แก้ให้จบ: ได้ HTTPS + ใบรับรองจริง โดยยังอยู่ใน tailnet เท่านั้น

เตรียมครั้งเดียวใน [admin console](https://login.tailscale.com/admin/dns):
เปิด **MagicDNS** และกด **Enable HTTPS** (แท็บ DNS)

จากนั้นบน Mac:

```sh
npm run remote:on         # proxy https://<เครื่อง>.<tailnet>.ts.net → localhost:3001
npm run remote:status     # ตรวจสถานะ
```

เปิดจากมือถือ: `https://<ชื่อเครื่อง>.<tailnet>.ts.net` (ไม่ต้องใส่พอร์ต)
— WebSocket ของ terminal วิ่งผ่านเป็น `wss://` อัตโนมัติ, Add to Home Screen ได้ PWA เต็มรูปแบบ

request แรกอาจใช้เวลาสิบกว่าวินาที (Tailscale กำลังไปขอใบรับรอง) หลังจากนั้นจะเร็วปกติ

ปิดเมื่อไม่ใช้:

```sh
npm run remote:off
```

> script ทั้งสามเรียก `tailscale` จาก PATH ถ้าหาไม่เจอจะ fallback ไปที่
> `/Applications/Tailscale.app/Contents/MacOS/Tailscale` — การลง Tailscale แบบแอป
> (Mac App Store / ดาวน์โหลดตรง) จะไม่ใส่ CLI ลง PATH ให้ ต้องเรียกจาก bundle แบบนี้

> ⚠️ **อย่าใช้ `tailscale funnel`** กับ Orbit — funnel เปิดบริการสู่อินเทอร์เน็ต
> สาธารณะจริง ๆ ต่างจาก `serve` ที่จำกัดอยู่ใน tailnet ของคุณ Orbit ควบคุม
> เครื่องคุณได้ทั้งเครื่อง แม้จะมี token ก็ไม่ควรเอาไปตากแดดไว้

## 4.1 ส่ง dev server ขึ้น tailnet ด้วย (จากมือถือ)

dev server เป็น http บนพอร์ตที่มีแต่ Mac มองเห็น — และแม้เข้าถึงได้ มันก็เป็น
http ซึ่ง Orbit (https) เอามาแสดงในเฟรมไม่ได้ (mixed content) ลิงก์จึงเหลือแค่
**Copy** และการกดตามไปคือการเดินออกจากแอป ซึ่งบน PWA แปลว่า session เสียหน้าจอ

แท็บ **Captures** มีแถวจัดการเรื่องนี้: พิมพ์ URL ของ dev server ลงช่องเดิม
(`http://localhost:3000`) แล้วกด **Share :3000 over https** Orbit จะเรียก
`tailscale serve` ให้เอง จองพอร์ต 8443 ขึ้นไปพอร์ตละ dev server แล้วแสดงเป็นแถว
— แตะแถวเพื่อเปิดทับ terminal (session ยังต่ออยู่ข้างหลัง), กด ✕ เพื่อปิด

จุดที่ทำให้วิธีนี้ชนะการเข้าตรงที่ `http://<เครื่อง>.<tailnet>.ts.net:3000`:

- **proxy ต่อจากในเครื่องเอง** dev server ที่ bind แค่ `127.0.0.1` (เช่น `vite`
  เปล่า ๆ, `python -m http.server`) จึงใช้ได้ โดยไม่ต้องแก้ config ของโปรเจกต์
- **ได้ https** เปิดในเฟรมได้ และแอปที่กำลังพัฒนาก็ได้ secure context ไปด้วย —
  ทดสอบ service worker / กล้อง / PWA install ของโปรเจกต์ตัวเองจากมือถือได้

Orbit จะไม่แตะ mapping ที่เป็นทางเข้าของตัวเอง (พอร์ต 443 หรืออันที่ชี้มาที่
พอร์ต server) — ปิดไม่ได้ทั้งจาก UI และจาก API เพราะนั่นคือการตัดสายที่กำลังคุยอยู่

### ในเฟรมทำอะไรได้บ้าง

| ปุ่ม | ได้อะไร |
| --- | --- |
| **↻** | โหลดหน้าใหม่ — agent แก้โค้ดเสร็จแล้วกดดูของใหม่ได้โดยไม่ต้องปิดเฟรม |
| **📷** | ส่ง **ภาพหน้าจอที่ถ่ายด้วย iOS** ให้ agent — เก็บตำแหน่งที่เลื่อน, modal ที่เปิดค้าง, ฟอร์มที่กรอกไว้ ครบ และเป็น WebKit จริง |
| **⧉** | เรนเดอร์**ทั้งหน้า**ใหม่แบบ headless จาก Mac — ได้ส่วนที่อยู่ใต้จอด้วย แต่ไม่มี state |

ทั้ง 📷 และ ⧉ จบด้วยการแทรก path ลง prompt แล้วปิดเฟรมให้ เพราะขั้นต่อไปคือพิมพ์อธิบาย

**ทำไมต้องมีทั้งสองอัน:** เฟรมเป็น iframe คนละ origin (Orbit อยู่ :443, preview อยู่
:8443) JS อ่านอะไรข้างในไม่ได้เลย — ทั้ง scroll position, DOM, พิกเซล ⧉ จึงทำได้แค่
ส่ง URL ไปเรนเดอร์ใหม่จากศูนย์ ส่วนสภาพที่คุณเห็นอยู่มีแต่ภาพหน้าจอของโทรศัพท์เองที่เก็บได้

### capture ยิงผ่าน https ที่ published

พอร์ตที่ share ไว้แล้ว เวลากด Capture จะเรนเดอร์ผ่าน tailnet https ไม่ใช่ `localhost`
เพราะสองอันนี้ไม่ใช่แอปเดียวกัน — secure context, cookie ที่มี `Secure`, service worker
ที่ลงทะเบียนได้, redirect ที่ผูกกับ scheme แอปที่พังเฉพาะบน https เคยถ่ายออกมาสวยงาม
ส่วนชื่อไฟล์ยังใช้พอร์ตเดิม (`localhost:3000`) ไม่งั้น gallery จะขึ้น `ts.net:8443`
เหมือนกันหมดจนแยกไม่ออกว่าเป็นแอปไหน — แถวที่ published มีปุ่มกล้องในตัว กดถ่ายได้เลย

> Next.js 15.2+ เตือนเมื่อ dev server ถูกเรียกจาก origin ที่ไม่ใช่ localhost —
> ใส่ tailnet hostname ใน `allowedDevOrigins` ของ `next.config.js` ถ้าเจอ

บรรทัดคำสั่งยังใช้ได้เหมือนเดิมสำหรับตอนที่ Orbit server ไม่ได้รัน:

```sh
PREVIEW_PORT=3000 npm run preview:on    # → https://<เครื่อง>.<tailnet>.ts.net:8443
npm run preview:off
```

## 5. (ตัวเลือก) ให้ Orbit server รันเองตอนเปิดเครื่อง

สร้างไฟล์ `~/Library/LaunchAgents/com.orbit.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.orbit.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string> <!-- ปรับเป็น path จริง: `which node` -->
    <string>/Users/YOUR_USER/Development/orbit/server/dist/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/orbit-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/orbit-server.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.orbit.server.plist
tail -f /tmp/orbit-server.log      # ดู access token ได้จาก log นี้
```

## Troubleshooting

| อาการ | ทางแก้ |
|---|---|
| มือถือเข้าไม่ถึงเลย | เช็คว่าสวิตช์ VPN ในแอป Tailscale เปิดอยู่ทั้งสองเครื่อง แล้ว `tailscale ping <ip-มือถือ>` จาก Mac |
| เข้าเว็บได้แต่ terminal ไม่เชื่อมต่อ | WebSocket ถูกบล็อก — ถ้าใช้ `serve` ต้องเข้าผ่าน `https://` ไม่ใช่ `http://…:3001` ปนกัน |
| ขึ้นหน้า login ทั้งที่เคยใส่ token แล้ว | token ผูกกับ origin — `http://100.x…:3001` กับ `https://….ts.net` เป็นคนละ origin ใส่ใหม่ครั้งเดียว |
| Mac หลับแล้วหลุด | System Settings → เสียบไฟ + ปิด "Put hard disks to sleep" หรือใช้ `caffeinate` / ตั้ง Amphetamine |
| อยากเปลี่ยน access token | ลบ `~/.orbit/config.json` แล้ว restart server — token ใหม่จะถูกพิมพ์ใน console |
