#!/usr/bin/env python3
"""
Test theemoviedb.hexa.su API access through Cloudflare (using hostname not IP).
Also test if the Pure-JS decryption works against it.
"""
import ssl, socket, json, time, hmac, hashlib, base64, secrets, sys

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
FINGERPRINT_LITE = "e9136c41504646444"

def raw_request_host(host, port, method, path, headers=None, body=None, timeout=15):
    """Connect using hostname (not IP) — goes through Cloudflare for hexa.su."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

    # Resolve DNS
    addrs = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
    ip = addrs[0][4][0]

    sock = socket.socket(); sock.settimeout(timeout)
    sock.connect((ip, port))
    ssock = ctx.wrap_socket(sock, server_hostname=host)

    req_headers = f"{method} {path} HTTP/1.1\r\nHost: {host}\r\n"
    if headers:
        for k, v in headers.items():
            req_headers += f"{k}: {v}\r\n"
    if body:
        req_headers += f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
    req_headers += "Connection: close\r\n\r\n"
    ssock.send(req_headers.encode())
    if body: ssock.send(body.encode() if isinstance(body, str) else body)
    resp = b""
    while True:
        try:
            data = ssock.recv(65536)
            if not data: break
            resp += data
        except: break
    ssock.close()
    resp_str = resp.decode('utf-8', errors='replace')
    parts = resp_str.split('\r\n\r\n', 1)
    hdr_part = parts[0] if parts else ""
    resp_body = parts[1] if len(parts) > 1 else ""
    lines = hdr_part.split('\r\n')
    hdrs = {}
    for line in lines[1:]:
        if ':' in line:
            k, v = line.split(':', 1)
            hdrs[k.strip().lower()] = v.strip()
    sc = int(lines[0].split()[1]) if len(lines[0].split()) > 1 else 0
    return sc, hdrs, resp_body

def generate_api_key():
    return secrets.token_hex(32)

def generate_nonce():
    return base64.b64encode(secrets.token_bytes(16)).decode().replace('/', '').replace('+', '').replace('=', '').ljust(22, 'a')[:22]

def generate_client_fingerprint():
    fp_str = f"1920x1080:24:{UA[:50]}:Win32:en-US:{int(time.timezone / 60)}:FP"
    h = 0
    for c in fp_str:
        h = ((h << 5) - h + ord(c)) & 0xFFFFFFFF
        if h < 0: h += 0x100000000
    return format(h, 'x')

def sign_request(api_key, timestamp, nonce, path):
    msg = f"{api_key}:{timestamp}:{nonce}:{path}"
    return base64.b64encode(hmac.new(api_key.encode(), msg.encode(), hashlib.sha256).digest()).decode()

def call_api_host(host, path, api_key, extra_headers=None, server_time=None, origin="https://hexa.su"):
    if server_time is None: server_time = int(time.time())
    nonce = generate_nonce()
    sig = sign_request(api_key, server_time, nonce, path)
    fp = generate_client_fingerprint()
    headers = {
        "X-Api-Key": api_key,
        "X-Request-Timestamp": str(server_time),
        "X-Request-Nonce": nonce,
        "X-Request-Signature": sig,
        "X-Client-Fingerprint": fp,
        "x-fingerprint-lite": FINGERPRINT_LITE,
        "User-Agent": UA,
        "Origin": origin,
        "Referer": f"{origin}/",
        "Accept": "text/plain",
    }
    if extra_headers: headers.update(extra_headers)
    sc, hdrs, body = raw_request_host(host, 443, "GET", path, headers=headers)
    return sc, hdrs, body

print("=" * 70)
print("TESTING themoviedb.hexa.su (through Cloudflare)")
print("=" * 70)

api_key = generate_api_key()
print(f"API Key: {api_key[:16]}...{api_key[-16:]}")

# Get server time
sc, hdrs, body = raw_request_host("theemoviedb.hexa.su", 443, "GET", "/api/time?t=" + str(int(time.time() * 1000)),
                                   headers={"User-Agent": UA})
print(f"Time [{sc}]: {body[:100]}")
if sc == 200:
    server_time = json.loads(body).get("timestamp", int(time.time()))
else:
    server_time = int(time.time())

# Fetch encrypted data
print("\nFetching encrypted data from themoviedb.hexa.su...")
sc, hdrs, body = call_api_host("theemoviedb.hexa.su", "/api/tmdb/movie/550/images", api_key, server_time=server_time)
print(f"Response [{sc}]: {len(body)} bytes")
print(f"Headers: {dict(hdrs)}")

if sc == 200:
    raw = base64.b64decode(body)
    print(f"Raw: {len(raw)} bytes")
    print(f"First 64 hex: {raw[:64].hex()}")

    # Try Ctr32BE with hex-decoded key
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.backends import default_backend

    key_bytes = bytes.fromhex(api_key)
    iv = raw[:16]
    ct = raw[16:]

    print(f"\nDecrypting with Ctr32BE (hex-decoded key)...")
    nonce = iv[:12]
    counter = bytearray(iv[12:16])
    num_blocks = (len(ct) + 15) // 16
    ecb = Cipher(algorithms.AES(key_bytes), modes.ECB(), backend=default_backend())
    encryptor = ecb.encryptor()
    pt = bytearray()
    for b in range(num_blocks):
        keystream = encryptor.update(bytes(nonce) + bytes(counter))
        start = b * 16
        end = min(start + 16, len(ct))
        for i in range(start, end):
            pt.append(ct[i] ^ keystream[i - start])
        for i in range(3, -1, -1):
            counter[i] = (counter[i] + 1) & 0xFF
            if counter[i] != 0: break
    result = bytes(pt)

    try:
        as_str = result.decode('utf-8')
        parsed = json.loads(as_str)
        print(f"*** SUCCESS! Decrypted JSON: {json.dumps(parsed, indent=2)[:500]}")
    except Exception as e:
        print(f"Decryption failed: {e}")
        print(f"First 100 bytes: {''.join(chr(b) if 32<=b<127 else '.' for b in result[:100])}")
        print(f"First 100 hex: {result[:100].hex()}")

# Also test: maybe the themoviedb.hexa.su is the SAME server as plsdontscrapemelove.flixer.su
# but with cloudflare in front. Let's verify by fetching /api/time from both.
print(f"\n{'='*70}")
print("COMPARISON: Both APIs return same data?")
print("=" * 70)

# plsdontscrapemelove.flixer.su direct (91.199.133.5)
def raw_request_ip(ip, sni, host, path):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    sock = socket.socket(); sock.settimeout(10)
    sock.connect((ip, 443))
    ssock = ctx.wrap_socket(sock, server_hostname=sni)
    req = f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: {UA}\r\nConnection: close\r\n\r\n"
    ssock.send(req.encode())
    resp = b""
    while True:
        try:
            data = ssock.recv(65536)
            if not data: break
            resp += data
        except: break
    ssock.close()
    return resp.decode('utf-8', errors='replace').split('\r\n\r\n', 1)[-1]

time1 = raw_request_ip("91.199.133.5", "plsdontscrapemelove.flixer.su", "plsdontscrapemelove.flixer.su", "/api/time")
print(f"plsdontscrapemelove.flixer.su (91.199.133.5): {time1}")

time2 = raw_request_host("theemoviedb.hexa.su", 443, "GET", "/api/time", headers={"User-Agent": UA})
print(f"theemoviedb.hexa.su (Cloudflare): {time2}")

# Also try reaching the CF Worker for decryption
print(f"\n{'='*70}")
print("TRYING CF WORKER /flixer/decrypt")
print("=" * 70)

# The CF Worker should be at the same domain as the Flixer site
# Let's check if there's a worker at api.flixer.su or similar
for worker_host in ["flixer.su", "api.flixer.su"]:
    try:
        sc, hdrs, body = raw_request_host(worker_host, 443, "GET", "/flixer/health",
                                           headers={"User-Agent": UA})
        print(f"  [{sc}] {worker_host}/flixer/health: {body[:100]}")
    except Exception as e:
        print(f"  {worker_host}: {str(e)[:80]}")

print("\nDone")
