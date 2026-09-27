// Shared color palette for the small floating cards content scripts inject into host
// pages (note input, note badges, explain-selection, picker toast). Each of these used
// to hardcode its own one-off colors — one dark-only, three light-only, none following
// the OS theme — this keeps them consistent with each other and with prefers-color-scheme.
export interface PopupColors {
  bg: string;
  text: string;
  border: string;
  muted: string;
  inputBg: string;
  inputBorder: string;
  accent: string;
  accentText: string;
  shadow: string;
}

export function popupColors(): PopupColors {
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return dark
    ? {
        bg: "#101318",
        text: "#e6e9ee",
        border: "#2a3240",
        muted: "#98a1b0",
        inputBg: "#0d1014",
        inputBorder: "#2a3240",
        accent: "#7fa6d6",
        accentText: "#0b0d10",
        shadow: "0 8px 24px rgba(0,0,0,0.5)"
      }
    : {
        bg: "#ffffff",
        text: "#222222",
        border: "#dfe3ea",
        muted: "#566072",
        inputBg: "#ffffff",
        inputBorder: "#c5ccd8",
        accent: "#2f5f9a",
        accentText: "#ffffff",
        shadow: "0 8px 24px rgba(0,0,0,0.18)"
      };
}
