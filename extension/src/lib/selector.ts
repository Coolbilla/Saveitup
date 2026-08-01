export function buildSelector(el: Element): string {
  const path: string[] = [];
  let node: Element | null = el;

  while (node && node.nodeType === 1 && path.length < 8) {
    if (node.id) {
      path.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let segment = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (siblings.length > 1) {
        segment += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
    }
    path.unshift(segment);
    node = node.parentElement;
  }

  return path.join(" > ");
}
