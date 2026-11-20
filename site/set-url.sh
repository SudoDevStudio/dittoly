#!/bin/sh
# Switch on the tags that need the site's public address (index.html and docs.html): canonical link, og:url, the share image, and the sitemap.
# Usage: site/set-url.sh https://your.domain/          (once, when the site's address is known)
set -eu
url="${1:?usage: site/set-url.sh https://your.domain/}"
case "$url" in https://*) ;; *) echo "The address must start with https://" >&2; exit 1 ;; esac
case "$url" in */) ;; *) url="$url/" ;; esac
dir=$(dirname "$0")
grep -q 'SITE-URL' "$dir/index.html" || { echo "Already set; edit the canonical tags in index.html and docs.html to change it." >&2; exit 1; }
for page in index.html docs.html; do
  sed -i.bak -e '/<!-- SITE-URL:/d' -e '/SITE-URL -->/d' -e "s#__SITE_URL__#$url#g" "$dir/$page" && rm "$dir/$page.bak"
done
cat > "$dir/sitemap.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>$url</loc></url>
  <url><loc>${url}docs.html</loc></url>
</urlset>
XML
printf '\nSitemap: %ssitemap.xml\n' "$url" >> "$dir/robots.txt"
echo "Done: index.html, sitemap.xml and robots.txt now use $url"
