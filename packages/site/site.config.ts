// The site's settings. The release links and the star count are filled in at build time (scripts/build.mjs) and reach
// the page as __SITE_DATA__; everything here is fixed.

export const siteConfig = {
  /** GitHub repository: links, releases, stars. */
  repo: "legostin/piomio",
  /** Public TestFlight link for the iPhone app (https://testflight.apple.com/join/…). Empty: the button says "soon". */
  testflightUrl: "https://testflight.apple.com/join/g4hCfeXA",
  /** The site's address once a domain is connected (canonical links, Open Graph); empty: GitHub Pages. */
  siteUrl: "",
  /** The server installer (packaging/linux/install.sh, published by the site's build), as the README and the hub's invite page give it. */
  installScript: "https://piomio.io/install.sh",
  /** What an agent follows to install Piomio for the person (public/setup.md), named in the prompt the site and the README give. */
  setupGuide: "https://piomio.io/setup.md",
  languages: ["en", "ru"] as const,
};

export type Lang = (typeof siteConfig.languages)[number];
