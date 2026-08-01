/**
 * Copy text, including where the modern way is unavailable.
 *
 * There is no clipboard API without a secure context, which plain http on the
 * LAN is not. The old way still works there, but only if iOS can see what it is
 * copying: a readonly or offscreen field copies nothing at all, so the stand-in
 * is editable, on screen, and one pixel wide.
 */
export async function writeToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const proxy = document.createElement('textarea')
    proxy.value = text
    proxy.contentEditable = 'true'
    proxy.readOnly = false
    proxy.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
    document.body.appendChild(proxy)
    const range = document.createRange()
    range.selectNodeContents(proxy)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    proxy.setSelectionRange(0, text.length)
    document.execCommand('copy')
    sel?.removeAllRanges()
    proxy.remove()
  }
}
