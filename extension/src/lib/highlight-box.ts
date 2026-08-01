export function drawHighlightBox(el: Element): void {
  const rect = el.getBoundingClientRect();
  const box = document.createElement("div");
  box.style.position = "fixed";
  box.style.pointerEvents = "none";
  box.style.zIndex = "2147483647";
  box.style.border = "3px solid #2563eb";
  box.style.borderRadius = "4px";
  box.style.background = "rgba(37, 99, 235, 0.15)";
  box.style.top = `${rect.top}px`;
  box.style.left = `${rect.left}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  box.style.transition = "opacity 0.6s ease-out";
  document.body.appendChild(box);

  setTimeout(() => {
    box.style.opacity = "0";
    setTimeout(() => box.remove(), 700);
  }, 2500);
}
