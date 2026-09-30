#!/usr/bin/env python3
"""Simple web fetch via urllib — extracts readable text from a URL."""
import urllib.request
import urllib.error
import re
import sys
import json

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

def html_to_text(raw):
    text = raw.decode("utf-8", errors="replace")
    text = re.sub(r'<script[^>]*>[\s\S]*?</script>', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'<style[^>]*>[\s\S]*?</style>', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'</(h[1-6]|p|li|tr|div|section|article|br)>', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'&amp;', '&', text)
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)
    text = re.sub(r'&quot;', '"', text)
    text = re.sub(r'&#39;', "'", text)
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = text.strip()
    if len(text) > 20000:
        text = text[:20000] + f"\n\n[truncated {len(text)-20000} chars]"
    return text

def run(url):
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        return {"ok": False, "url": url, "error": "invalid URL"}
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Codex-Translator-WebFetch/0.1 (+local adapter)",
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read(1_000_000)
            return {"ok": True, "url": url, "status": resp.status, "text": html_to_text(raw)}
    except urllib.error.HTTPError as e:
        return {"ok": False, "url": url, "status": e.code, "error": str(e)}
    except Exception as e:
        return {"ok": False, "url": url, "error": str(e)}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "URL required"}))
        sys.exit(1)

    print(json.dumps(run(sys.argv[1]), ensure_ascii=False))

if __name__ == "__main__":
    main()
