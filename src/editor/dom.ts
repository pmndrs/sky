export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
  node.append(...children)
  return node
}

export function button(label: string, action: () => void, signal: AbortSignal): HTMLButtonElement {
  const node = element('button', { type: 'button' }, label)
  node.addEventListener('click', action, { signal })
  return node
}

export function select(label: string, items: [string, string][]): HTMLSelectElement {
  return element('select', { 'aria-label': label }, ...items.map(([value, text]) => element('option', { value }, text)))
}
