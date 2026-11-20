# Dittoly website

The introductory page for Dittoly: plain HTML, CSS and a few lines of JavaScript, with no build step and no external
requests (system fonts, inline SVG).

- **Preview:** open `site/index.html` in a browser, or run `npx serve site`.
- **Host:** any static host. For GitHub Pages, publish the `site/` folder.
- **Style:** minimal layout with one spatial element, the layered Flow in the hero. Colours follow the app
  (`web/src/styles.css`) in light and dark. The hero tilts toward the pointer, except when the visitor's system asks for
  reduced motion.

Keep claims on the page in line with the docs; it states only what Dittoly does today.

## Search and AI answers

- **In the page:** title and description, Open Graph and X/Twitter cards (`og-image.png`, 1200×630), and
  JSON-LD for `SoftwareApplication` and `FAQPage`. The FAQ structured data repeats the visible questions word for word;
  change both together.
- **`robots.txt`** allows all crawlers. **`llms.txt`** gives AI tools a short summary and the main doc links.
- **Once the site's address is known**, run `site/set-url.sh https://your.domain/` once. It switches on the canonical
  link, `og:url` and the share image tags, writes `sitemap.xml`, and adds it to `robots.txt`. Until then those tags
  stay commented out, because a wrong canonical address would do more harm than none.
