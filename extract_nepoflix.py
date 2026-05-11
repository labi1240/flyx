#!/usr/bin/env python3
"""Extract source provider logic from nepoflix JS bundle."""
import re, json, sys

with open(r'C:\Users\Nicks\Desktop\Flyx-main\nepoflix-bundle.js', 'r', encoding='utf-8') as f:
    js = f.read()

def safe_print(text, maxlen=3000):
    text = str(text)
    if len(text) > maxlen:
        text = text[:maxlen] + "\n... (truncated)"
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode('ascii', errors='replace').decode('ascii'))

def extract_block(js, start_pos, open_ch, close_ch):
    depth = 0
    in_str = False
    sc = None
    i = start_pos
    while i < len(js):
        c = js[i]
        if in_str:
            if c == sc and (i == 0 or js[i-1] != '\\'):
                in_str = False
        elif c in "'\"`":
            in_str = True
            sc = c
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return js[start_pos:i+1]
        i += 1
    return js[start_pos:i]

# 1. Sources array
print("=" * 80)
print("1. SOURCES ARRAY")
print("=" * 80)
for m in re.finditer(r'ec=\[', js):
    start = js.index('[', m.start())
    block = extract_block(js, start, '[', ']')
    safe_print(block)
    break

# 2. URL resolver
print("\n" + "=" * 80)
print("2. URL RESOLVER YW")
print("=" * 80)
for m in re.finditer(r'function\s+YW\(', js):
    start = js.index('{', m.end())
    block = extract_block(js, start, '{', '}')
    safe_print("function YW" + block[:1500])
    break

# 3. gn proxy config
print("\n" + "=" * 80)
print("3. gn CONFIG")
print("=" * 80)
for m in re.finditer(r'\bgn\s*=\s*\{', js):
    start = js.index('{', m.start())
    block = extract_block(js, start, '{', '}')
    safe_print("gn =" + block[:2000])
    break

# 4. Main source loading function (the one with Fox/PrimeNet logic)
print("\n" + "=" * 80)
print("4. MAIN SOURCE FETCHING LOGIC (Fox/PrimeNet)")
print("=" * 80)
idx = js.find('Fox API error')
if idx > 0:
    pre = js[idx-2500:idx]
    # find the enclosing function
    fn_match = list(re.finditer(r'(async\s+)?function\s+\w+\s*\(|const\s+\w+\s*=\s*async\s*\(', pre))
    if fn_match:
        fn = fn_match[-1]
        fn_body_start = js.index('{', fn.start())
        block = extract_block(js, fn_body_start, '{', '}')
        safe_print(block[:6000])

# 5. Q4 dispatch
print("\n" + "=" * 80)
print("5. Q4 DISPATCH TABLE")
print("=" * 80)
for m in re.finditer(r'Q4\s*=\s*function', js):
    start = js.index('{', m.end())
    block = extract_block(js, start, '{', '}')
    safe_print(block[:2000])
    break

# 6. External embed extractors
print("\n" + "=" * 80)
print("6. EMBED EXTRACTOR FUNCTIONS")
print("=" * 80)

# Find all function assignments to oU, lU, cU, dU, fU
for var in ['oU', 'lU', 'cU', 'dU', 'fU']:
    print(f"\n--- {var} ---")
    # Pattern: var = async (params) => {
    # Pattern: var = function(params) {
    # Pattern: var = (params) => {
    pat = re.compile(re.escape(var) + r'\s*=\s*(?:async\s+)?(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{')
    for m in pat.finditer(js):
        brace_idx = js.index('{', m.start())
        block = extract_block(js, brace_idx, '{', '}')
        safe_print(block[:3000])
        break

# 7. Zenime extraction
print("\n" + "=" * 80)
print("7. ZENIME EXTRACTION")
print("=" * 80)
for m in re.finditer(r'api\.zenime\.site', js):
    safe_print(js[max(0,m.start()-800):m.start()+1800])
    print("---")
    break

# 8. Proxy definitions
print("\n" + "=" * 80)
print("8. PROXY ROUTE DEFINITIONS")
print("=" * 80)
# Find route path definitions
for m in re.finditer(r'["\']/proxy["\']|["\']/m3u8proxy["\']', js):
    safe_print(js[max(0,m.start()-200):m.end()+300])
    print("---")

# 9. Find what the /e/fox and /e/zenime routes do
print("\n" + "=" * 80)
print("9. ROUTE HANDLERS (/e/fox, /e/zenime, /e/primenet)")
print("=" * 80)
for m in re.finditer(r'path:["\']/e/(?:fox|zenime|primenet)', js):
    safe_print(js[m.start():m.end()+400])
    print("---")

# 10. Find the component that calls Q4 / the main source dispatch
print("\n" + "=" * 80)
print("10. FOX/PRIMENET/ZENIME DISPATCH COMPONENT")
print("=" * 80)
# Find the component that handles the different servers
for m in re.finditer(r'server:*["\'](?:fox|primenet|zenime)', js):
    safe_print(js[max(0,m.start()-1500):m.start()+1500])
    print("---")
    break

# 11. Find where the user can select sources (UI)
print("\n" + "=" * 80)
print("11. SOURCE SELECTION UI")
print("=" * 80)
for m in re.finditer(r'fox["\']*\s*:\s*["\']*Fox|primenet["\']*\s*:\s*["\']*PrimeNet', js):
    safe_print(js[max(0,m.start()-400):m.start()+500])
