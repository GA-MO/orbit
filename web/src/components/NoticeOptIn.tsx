import { useState } from 'react'
import { enableNotices, noticePermission } from '../notice'
import { Button } from './ui'

/**
 * Offers to turn on notifications, and exists mainly because iOS will only
 * grant them from a real tap inside an installed PWA — asking on page load is
 * refused outright. Disappears once answered either way.
 */
export default function NoticeOptIn({ onToast }: { onToast: (message: string) => void }) {
  const [permission, setPermission] = useState(noticePermission)
  const [busy, setBusy] = useState(false)

  if (permission !== 'default') return null

  const enable = async () => {
    setBusy(true)
    const result = await enableNotices()
    setPermission(result)
    setBusy(false)
    if (result === 'granted') onToast('Notifications on — your Mac can reach you now')
    else if (result === 'denied') onToast('Notifications blocked — turn them on in Settings')
  }

  return (
    <div className="mx-4 mb-3 flex items-center gap-3 rounded-(--radius-card) border border-line-subtle bg-surface px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">Notify me when the Mac needs me</div>
        <p className="mt-0.5 text-xs text-mut">
          An agent finishing, or asking something, reaches you with the phone locked
        </p>
      </div>
      <Button disabled={busy} onClick={enable} className="shrink-0 px-3 py-1.5 text-[13px]">
        {busy ? 'Asking…' : 'Turn on'}
      </Button>
    </div>
  )
}
