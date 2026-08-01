export type CaptureType = "note" | "highlight" | "element" | "full";

// Note takes top priority: whether it came from the right-click "Take a
// note" flow (carries highlightText too) or the sidepanel's note button
// (no highlight at all), the note is the point of the save.
export function getCaptureType(p: {
  hasNote: boolean;
  hasHighlight: boolean;
  hasElementSelector: boolean;
}): CaptureType {
  if (p.hasNote) return "note";
  if (p.hasHighlight) return "highlight";
  if (p.hasElementSelector) return "element";
  return "full";
}

export function captureTypeLabel(type: CaptureType): string {
  switch (type) {
    case "note":
      return "Note";
    case "highlight":
      return "Highlight";
    case "element":
      return "Picked element";
    default:
      return "Full page";
  }
}

export function captureTypeBadgeClass(type: CaptureType): string {
  return `badge-${type}`;
}
