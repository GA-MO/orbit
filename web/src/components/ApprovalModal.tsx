import type { ApprovalRequest } from '../Terminal'
import { Button } from './ui'

interface Props {
  request: ApprovalRequest
  onApprove: () => void
  onDeny: () => void
}

export default function ApprovalModal({ request, onApprove, onDeny }: Props) {
  return (
    <div className="fade-in app-fill z-50 flex items-center justify-center bg-black/60 p-5 backdrop-blur-[2px]">
      <div className="pop-in lift flex w-full max-w-md flex-col gap-3.5 rounded-2xl border border-danger/40 bg-surface p-5">
        <div className="font-display text-[15px] font-semibold text-danger">
          Dangerous command held
        </div>
        <div className="text-[13px] text-mut">{request.label}</div>
        <code className="rounded-(--radius-field) border border-line bg-ink px-3.5 py-2.5 font-mono text-[13px] break-all">
          {request.command}
        </code>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onDeny}>
            Deny
          </Button>
          <Button variant="danger" className="flex-1" onClick={onApprove}>
            Run anyway
          </Button>
        </div>
      </div>
    </div>
  )
}
