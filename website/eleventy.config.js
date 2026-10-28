// Eleventy config for the MomentCast marketing site (momentcast.live).
// Phase 1: build only. Pages are copied through unchanged, so the output
// matches the hand-written site byte for byte.

export default function (eleventyConfig) {
  // Mirror input paths in the output: src/terms.html -> _site/terms.html.
  // Eleventy's default would write _site/terms/index.html, which Cloudflare
  // serves at /terms/ (trailing slash) and breaks the indexed URLs.
  // Any page can override this with its own front matter permalink.
  eleventyConfig.addGlobalData("permalink", () => {
    return (data) => `${data.page.filePathStem}.${data.page.outputFileExtension}`;
  });

  // Static files go straight to the output. robots.txt and sitemap.xml are
  // here because .txt and .xml are not template formats. sitemap.xml becomes
  // a generated template in Phase 4.
  eleventyConfig.addPassthroughCopy("src/**/*.{css,png,jpg,jpeg,webp,svg,ico,txt,xml}");

  // Turns an output URL into the public one Cloudflare serves:
  // /terms.html -> /terms, /blog/index.html -> /blog/, /index.html -> /
  // Used for canonical and og:url tags (and the sitemap in Phase 4).
  eleventyConfig.addFilter("cleanUrl", (url) =>
    url.replace(/index\.html$/, "").replace(/\.html$/, "")
  );

  // Build timestamp for cache-busting (style.css?v=...). Each deploy gets a
  // new URL, so browsers and Cloudflare's edge can't serve a stale stylesheet.
  eleventyConfig.addGlobalData("buildTime", () => Date.now());
}

export const config = {
  dir: {
    input: "src",
    output: "_site",
  },
  // false = .html files are not run through any template engine.
  // Nothing in them is parsed, so no {{ }} or {% %} surprises in Phase 1.
  // Pages move to .njk in Phase 2, where Nunjucks takes over on purpose.
  htmlTemplateEngine: false,
  markdownTemplateEngine: "njk",
};