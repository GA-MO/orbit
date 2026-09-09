const IOS_VISIBLE_PROXY_STYLE = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'

function copyViaEditableProxy(text: string): void {
  const proxy = document.createElement('textarea')
  proxy.value = text
  proxy.contentEditable = 'true'
  proxy.readOnly = false
  proxy.style.cssText = IOS_VISIBLE_PROXY_STYLE
  document.body.appendChild(proxy)

  const range = document.createRange()
  range.selectNodeContents(proxy)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  proxy.setSelectionRange(0, text.length)

  document.execCommand('copy')
  selection?.removeAllRanges()
  proxy.remove()
}

export async function writeToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    copyViaEditableProxy(text)
  }
}
