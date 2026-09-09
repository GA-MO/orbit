import { useState } from 'react'
import { enableNotices, noticePermission } from '../notice'
import { Button } from './ui'

const GRANTED_MESSAGE = 'Notifications on — your Mac can reach you now'
const DENIED_MESSAGE = 'Notifications blocked — turn them on in Settings'

export default function NoticeOptIn({ onToast }: { onToast: (message: string) => void }) {
  const [permission, setPermission] = useState(noticePermission)
  const [busy, setBusy] = useState(false)

  if (permission !== 'default') return null

  const enableFromThisTap = async () => {
    setBusy(true)
    const result = await enableNotices()
    setPermission(result)
    setBusy(false)
    if (result === 'granted') onToast(GRANTED_MESSAGE)
    else if (result === 'denied') onToast(DENIED_MESSAGE)
  }

  return (
    <div className="mx-4 mb-3 flex items-center gap-3 rounded-(--radius-card) border border-line-subtle bg-surface px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">Notify me when the Mac needs me</div>
        <p className="mt-0.5 text-xs text-mut">
          An agent finishing, or asking something, reaches you with the phone locked
        </p>
      </div>
      <Button disabled={busy} onClick={enableFromThisTap} className="shrink-0 px-3 py-1.5 text-[13px]">
        {busy ? 'Asking…' : 'Turn on'}
      </Button>
    </div>
  )
}
