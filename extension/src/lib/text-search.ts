function elementContainsProbe(el: Element, probe: string): boolean {
  return (el.textContent ?? "").toLowerCase().includes(probe);
}

function searchChildren(parent: Element | ShadowRoot, probe: string): Element | null {
  for (const child of Array.from(parent.children)) {
    const found = searchElement(child, probe);
    if (found) return found;
  }
  return null;
}

// `textContent` doesn't cross shadow boundaries, and a single Text node may not
// contain a full multi-word probe if the site splits it across spans — so this
// recurses into shadow roots explicitly and prefers the deepest element whose
// flattened descendant text contains the probe, rather than matching on
// individual Text nodes.
function searchElement(el: Element, probe: string): Element | null {
  if (el.shadowRoot) {
    const shadowMatch = searchChildren(el.shadowRoot, probe);
    if (shadowMatch) return shadowMatch;
  }
  const childMatch = searchChildren(el, probe);
  if (childMatch) return childMatch;
  return elementContainsProbe(el, probe) ? el : null;
}

export function findElementContainingText(needle: string): Element | null {
  const target = needle.trim().toLowerCase();
  if (!target) return null;
  const probe = target.slice(0, Math.min(60, target.length));
  return searchElement(document.body, probe);
}
