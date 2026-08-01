export interface SiteCapture {
  file: string;
  func: () => Promise<{ description: string | null; transcript: string | null }>;
}

export const SITE_CAPTURES: Record<string, SiteCapture> = {
  "youtube.com": {
    file: "content/youtube-capture.js",
    func: () => (window as any).__saveItUpCaptureYouTube()
  },
  "instagram.com": {
    file: "content/instagram-capture.js",
    func: () => Promise.resolve((window as any).__saveItUpCaptureInstagram())
  },
  "x.com": {
    file: "content/x-capture.js",
    func: () => Promise.resolve((window as any).__saveItUpCaptureX())
  },
  "twitter.com": {
    file: "content/x-capture.js",
    func: () => Promise.resolve((window as any).__saveItUpCaptureX())
  },
  "linkedin.com": {
    file: "content/linkedin-capture.js",
    func: () => Promise.resolve((window as any).__saveItUpCaptureLinkedIn())
  },
  "reddit.com": {
    file: "content/reddit-capture.js",
    func: () => Promise.resolve((window as any).__saveItUpCaptureReddit())
  }
};

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function matchSiteCapture(domain: string): SiteCapture | undefined {
  for (const key of Object.keys(SITE_CAPTURES)) {
    if (domain === key || domain.endsWith(`.${key}`)) return SITE_CAPTURES[key];
  }
  return undefined;
}
