export interface SiteCaptureResult {
  description: string | null;
  transcript: string | null;
  /** Site-specific capture (YouTube) can replace the generic page text, title and mark its format. */
  pageContent?: string;
  title?: string;
  format?: "youtube-v1";
}

export interface SiteCapture {
  file: string;
  func: () => Promise<SiteCaptureResult>;
}

/** Merges a site capture over the generic capture: a site that supplies its own pageContent/title wins. */
export function mergeSiteCapture(
  generic: { title: string; pageContent: string },
  site: SiteCaptureResult | null | undefined
) {
  return {
    title: site?.title || generic.title,
    pageContent: site?.pageContent || generic.pageContent,
    description: site?.description ?? null,
    transcript: site?.transcript ?? null,
    format: site?.format
  };
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
