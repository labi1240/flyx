'use client';

import { useState, useRef } from 'react';

const MEGAUP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const ENCDEC_API = 'https://enc-dec.app/api/dec-mega';
const CHROME_PROXY = 'http://localhost:8765';
let proxyAvailable: boolean | null = null;

function bytesToHex(bytes: Uint8Array, max?: number): string {
  const len = max ? Math.min(bytes.length, max) : bytes.length;
  return Array.from(bytes.subarray(0, len))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function b64decode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binaryStr = atob(padded);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return bytes;
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const len = Math.min(a.length, b.length);
  const result = new Uint8Array(len);
  for (let i = 0; i < len; i++) result[i] = a[i] ^ b[i];
  return result;
}

export default function MegaUpKeystreamPage() {
  const [status, setStatus] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [videoIdInput, setVideoIdInput] = useState('');
  const [hostInput, setHostInput] = useState('megaup22.online');
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  function log(msg: string) {
    setStatus(prev => prev + msg + '\n');
    setTimeout(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, 10);
  }

  async function runDiagnostics() {
    setStatus('');
    setAnalysis('');
    setRunning(true);

    try {
      const swActive = 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null;
      const swReg = await navigator.serviceWorker.getRegistration();
      const swUrl = swReg?.active?.scriptURL || 'none';

      log('=== SW Status ===');
      log('SW active (controller): ' + swActive);
      log('SW script URL: ' + swUrl);
      log('SW version in URL: ' + (swUrl.match(/v=(\d+)/)?.[1] || 'unknown'));
      log('');

      // Test 1: no-cors fetch (bypasses CORS, tests raw connectivity)
      log('=== Test 1: no-cors fetch (bypasses SW+CORS) ===');
      const hosts = ['megaup22.online', 'megaup.cc', 'megaup.live'];
      for (const host of hosts) {
        try {
          const res = await fetch('https://' + host + '/', {
            mode: 'no-cors',
            signal: AbortSignal.timeout(8000),
          });
          log('  ' + host + ': ' + res.type + ' — TCP/TLS OK');
        } catch (e: any) {
          log('  ' + host + ': ' + e.name + ': ' + e.message);
        }
      }

      // Test 2: cors fetch (goes through SW if pattern matches)
      log('\n=== Test 2: cors fetch (SW intercepts if pattern matches) ===');
      for (const host of hosts) {
        try {
          const res = await fetch('https://' + host + '/', {
            signal: AbortSignal.timeout(8000),
          });
          log('  ' + host + ': HTTP ' + res.status + ' — CORS+SW OK');
        } catch (e: any) {
          log('  ' + host + ': ' + e.name + ': ' + e.message);
        }
      }

      // Test 3: try the actual /media/ API with cors (SW must handle it)
      log('\n=== Test 3: /media/ API (cors via SW useOriginalRequest) ===');
      const testVid = 'jIrrLzj-WS2JcOLzF79O5xvpCQ';
      const testHost = 'megaup22.online';
      try {
        const res = await fetch('https://' + testHost + '/media/' + testVid, {
          signal: AbortSignal.timeout(8000),
        });
        const json = await res.json();
        log('  /media/: HTTP ' + res.status + ', has result: ' + !!json.result + ', result length: ' + (json.result?.length || 0));
      } catch (e: any) {
        log('  /media/: ' + e.name + ': ' + e.message);
      }

      // Test 4: enc-dec.app (connectivity only — "test" is invalid encrypted data)
      log('\n=== Test 4: enc-dec.app ===');
      try {
        const res = await fetch(ENCDEC_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'test', agent: MEGAUP_UA }),
          signal: AbortSignal.timeout(8000),
        });
        const body = await res.text().catch(() => '');
        log('  enc-dec.app: HTTP ' + res.status + ' (' + body.substring(0, 80) + ')');
        log('  Note: non-200 expected — "test" is not valid encrypted data');
      } catch (e: any) {
        log('  enc-dec.app: ' + e.name + ': ' + e.message);
      }

      log('\n=== Diagnostics Complete ===');
      log('Check results above:');
      log('  - If no-cors works but cors fails → SW useOriginalRequest may not be handling it');
      log('  - If both fail → MegaUp is blocking this IP entirely');
      log('  - If Test 3 returns JSON successfully → ready to collect data');
    } finally {
      setRunning(false);
    }
  }

  async function fetchMegaUpJson(id: string, host: string): Promise<any> {
    // Try Chrome proxy first (bypasses Origin/Referer issues entirely)
    if (proxyAvailable !== false) {
      try {
        const proxyUrl = CHROME_PROXY + '/media/' + id + '?host=' + host;
        const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(20000) });
        if (res.ok) {
          const json = await res.json();
          proxyAvailable = true;
          log('  via Chrome proxy OK');
          return json;
        }
        log('  Chrome proxy returned ' + res.status + ': ' + JSON.stringify(await res.json().catch(() => ({}))));
      } catch (e: any) {
        if (proxyAvailable === null) log('  Chrome proxy not available (' + e.message + '), falling back to SW...');
        proxyAvailable = false;
      }
    }

    // Fallback: direct fetch through SW (may fail due to Origin: localhost)
    const url = 'https://' + host + '/media/' + id;
    log('  Direct fetch via SW: ' + url);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + ': ' + body.substring(0, 200));
    }
    const json = await res.json();
    return json;
  }

  async function processVideo(id: string, host: string, label: string): Promise<any> {
    const url = 'https://' + host + '/media/' + id;
    log('\n[' + label + '] GET ' + url);

    const json = await fetchMegaUpJson(id, host);
    if (json.status !== 200 || !json.result) {
      throw new Error('API error: ' + JSON.stringify(json).substring(0, 200));
    }

    const encB64 = json.result;
    const encBytes = b64decode(encB64);
    log('  Encrypted: ' + encBytes.length + ' bytes');

    log('  Calling enc-dec.app...');
    const decRes = await fetch(ENCDEC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: encB64, agent: MEGAUP_UA }),
      signal: AbortSignal.timeout(15000),
    });

    if (!decRes.ok) throw new Error('enc-dec HTTP ' + decRes.status);
    const decData = await decRes.json();
    if (decData.status !== 200 || !decData.result) throw new Error('enc-dec no result');

    const plainStr = typeof decData.result === 'string' ? decData.result : JSON.stringify(decData.result);
    const plainBytes = new TextEncoder().encode(plainStr);
    log('  Plaintext: ' + plainBytes.length + ' bytes');
    log('  Preview: ' + plainStr.substring(0, 120) + '...');

    const ciphertext = encBytes.subarray(0, plainBytes.length);
    const tail = encBytes.subarray(plainBytes.length);
    log('  Ciphertext: ' + ciphertext.length + 'B, Tail: ' + tail.length + 'B');

    const ks = xorBytes(ciphertext, plainBytes);
    log('  Keystream: ' + ks.length + ' bytes');
    log('  KS[0:40]: ' + bytesToHex(ks.subarray(0, 40)));

    return { id, host, label, encB64, encBytes, plainStr, plainBytes, ciphertext, tail, ks };
  }

  async function runWithHardcoded() {
    setStatus('');
    setAnalysis('');
    setRunning(true);

    try {
      log('SW active: ' + ('serviceWorker' in navigator && navigator.serviceWorker.controller !== null));

      const videoIds = [
        { id: 'jIrrLzj-WS2JcOLzF79O5xvpCQ', host: 'megaup22.online', label: 'OPM-E1-Sub' },
        { id: 'jKfJZ2GHWS2JcOLzF79M6RvpCQ', host: 'megaup22.online', label: 'OPM-E1-Dub' },
      ];

      const collected: any[] = [];
      for (const vid of videoIds) {
        try {
          collected.push(await processVideo(vid.id, vid.host, vid.label));
        } catch (e: any) {
          log('  FAILED: ' + e.message);
        }
      }

      await runComparison(collected);
    } finally {
      setRunning(false);
    }
  }

  async function runWithCustom() {
    if (!videoIdInput.trim()) { log('Enter a video ID first.'); return; }
    setStatus('');
    setAnalysis('');
    setRunning(true);

    try {
      const collected: any[] = [];
      try {
        collected.push(await processVideo(videoIdInput.trim(), hostInput.trim(), 'Custom-1'));
      } catch (e: any) {
        log('  FAILED: ' + e.message);
      }

      try {
        const stored = JSON.parse(localStorage.getItem('megaup-samples') || '[]');
        if (collected[0]) {
          const s = collected[0];
          stored.push({
            id: s.id, host: s.host, label: s.label,
            encB64: s.encB64, plainStr: s.plainStr,
            ksHex: bytesToHex(s.ks), tailHex: bytesToHex(s.tail),
          });
          localStorage.setItem('megaup-samples', JSON.stringify(stored));
          log('\nSaved. Total stored: ' + stored.length + '. Run again with another ID, then "Compare from Storage".');
        }
      } catch {}
    } finally {
      setRunning(false);
    }
  }

  async function runFromStorage() {
    setStatus('');
    setAnalysis('');
    setRunning(true);

    try {
      const stored = JSON.parse(localStorage.getItem('megaup-samples') || '[]');
      if (stored.length < 2) {
        log('Need 2+ stored samples. Currently: ' + stored.length + '. Collect samples first.');
        setRunning(false);
        return;
      }

      log('Loaded ' + stored.length + ' stored samples.\n');
      const collected: any[] = [];
      for (const s of stored) {
        const encBytes = b64decode(s.encB64);
        const plainBytes = new TextEncoder().encode(s.plainStr);
        collected.push({
          ...s, encBytes, plainBytes,
          ciphertext: encBytes.subarray(0, plainBytes.length),
          tail: encBytes.subarray(plainBytes.length),
          ks: xorBytes(encBytes.subarray(0, plainBytes.length), plainBytes),
        });
        log('[' + s.label + '] ' + s.id.substring(0, 30) + '... KS=' + collected[collected.length-1].ks.length + 'B Tail=' + collected[collected.length-1].tail.length + 'B');
      }
      await runComparison(collected);
    } finally {
      setRunning(false);
    }
  }

  async function runComparison(collected: any[]) {
    if (collected.length < 2) {
      log('\nNeed at least 2 samples.');
      return;
    }

    log('\n========== COMPARISON ==========');
    let text = '';
    const [s0, s1] = collected;

    const minKsLen = Math.min(s0.ks.length, s1.ks.length);
    let firstDiff = -1;
    for (let i = 0; i < minKsLen; i++) {
      if (s0.ks[i] !== s1.ks[i]) { firstDiff = i; break; }
    }

    text += 'First keystream diff: byte ' + firstDiff + '\n';
    text += 'Common prefix (' + firstDiff + 'B): ' + bytesToHex(s0.ks.subarray(0, firstDiff), 48) + '\n\n';

    text += '=== Tail Analysis ===\n';
    text += s0.label + ' tail (' + s0.tail.length + 'B): ' + bytesToHex(s0.tail, 48) + '...\n';
    text += s1.label + ' tail (' + s1.tail.length + 'B): ' + bytesToHex(s1.tail, 48) + '...\n';
    let tailDiffs = 0;
    for (let i = 0; i < Math.min(s0.tail.length, s1.tail.length); i++) {
      if (s0.tail[i] !== s1.tail[i]) tailDiffs++;
    }
    text += 'Tail bytes differing: ' + tailDiffs + '/' + Math.min(s0.tail.length, s1.tail.length) + '\n\n';

    text += '=== Correlation Tests ===\n';
    const ksXorDiv = s0.ks[firstDiff] ^ s1.ks[firstDiff];
    text += 'ks_XOR at divergence (byte ' + firstDiff + '): 0x' + ksXorDiv.toString(16) + '\n';
    for (let ti = 0; ti < Math.min(s0.tail.length, s1.tail.length); ti++) {
      if ((s0.tail[ti] ^ s1.tail[ti]) === ksXorDiv) {
        text += '  tail_XOR[' + ti + '] matches ks_XOR[' + firstDiff + ']!\n';
      }
    }

    text += '\n=== Direct Tail Hypothesis (ks[' + firstDiff + ':] == tail) ===\n';
    for (const s of collected) {
      let matches = 0;
      const tl = Math.min(s.ks.length - firstDiff, s.tail.length);
      for (let i = 0; i < tl; i++) {
        if (s.ks[firstDiff + i] === s.tail[i]) matches++;
      }
      text += s.label + ': ' + matches + '/' + tl + '\n';
    }

    text += '\n=== Tail XOR UA_repeated ===\n';
    const uaBytes = new TextEncoder().encode(MEGAUP_UA);
    for (const s of collected) {
      let matches = 0;
      const tl = Math.min(s.ks.length, s.tail.length);
      for (let i = 0; i < tl; i++) {
        if (s.ks[i] === (s.tail[i] ^ uaBytes[i % uaBytes.length])) matches++;
      }
      text += s.label + ': ' + matches + '/' + tl + '\n';
    }

    text += '\n=== ks XOR tail Structure ===\n';
    for (const s of collected) {
      const tl = Math.min(s.ks.length, s.tail.length);
      const xored = xorBytes(s.ks.subarray(0, tl), s.tail);
      text += s.label + ': ' + new Set(xored).size + ' unique values, [0:32]=' + bytesToHex(xored.subarray(0, 32)) + '\n';
    }

    if (collected.length >= 2) {
      text += '\n=== Cross-video (ks XOR tail) comparison ===\n';
      const tl = Math.min(
        Math.min(s0.ks.length, s0.tail.length),
        Math.min(s1.ks.length, s1.tail.length)
      );
      const kxt0 = xorBytes(s0.ks.subarray(0, tl), s0.tail);
      const kxt1 = xorBytes(s1.ks.subarray(0, tl), s1.tail);
      let kxtMatch = 0;
      for (let i = 0; i < tl; i++) if (kxt0[i] === kxt1[i]) kxtMatch++;
      text += 'ksXORtail same across videos: ' + kxtMatch + '/' + tl + '\n';
      text += 'XOR of ksXORtails: ' + bytesToHex(xorBytes(kxt0, kxt1).subarray(0, 40)) + '\n';
    }

    // ── Web Crypto API hypothesis tests ──────────────────────────

    text += '\n=== Web Crypto: SHA256(UA) ===\n';
    try {
      const uaEnc = new TextEncoder().encode(MEGAUP_UA);
      const uaHash = await crypto.subtle.digest('SHA-256', uaEnc);
      text += 'SHA256(UA): ' + bytesToHex(new Uint8Array(uaHash)) + '\n';
      const hashBytes = new Uint8Array(uaHash);
      for (const s of collected) {
        const tl = Math.min(s.tail.length, hashBytes.length);
        const xored = xorBytes(s.tail.subarray(0, tl), hashBytes.subarray(0, tl));
        text += s.label + ' tail XOR SHA256(UA)[0:' + tl + ']: ' + bytesToHex(xored, 48) + '\n';
      }
    } catch (e: any) { text += 'SHA256 failed: ' + e.message + '\n'; }

    text += '\n=== Web Crypto: AES-256-CTR decrypt tail (iv=ciphertext[0:16]) ===\n';
    text += 'Hypothesis: tail = AES-CTR(ks_suffix, key=SHA256(UA), iv=ct[0:16])\n';
    try {
      const uaEnc = new TextEncoder().encode(MEGAUP_UA);
      const uaHash = await crypto.subtle.digest('SHA-256', uaEnc);
      const key = await crypto.subtle.importKey('raw', uaHash, { name: 'AES-CTR' }, false, ['decrypt']);
      for (const s of collected) {
        const iv = s.encBytes.subarray(0, 16);
        const tailLen = Math.floor(s.tail.length / 16) * 16;
        if (tailLen < 16) { text += s.label + ': tail too short for AES block\n'; continue; }
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-CTR', counter: iv, length: 128 }, key, s.tail.subarray(0, tailLen));
        const decBytes = new Uint8Array(decrypted);
        let matches = 0;
        const tl = Math.min(decBytes.length, s.ks.length - firstDiff);
        for (let i = 0; i < tl; i++) { if (decBytes[i] === s.ks[firstDiff + i]) matches++; }
        text += s.label + ': ' + matches + '/' + tl + ' match ks[' + firstDiff + ':]\n';
        text += '  dec[0:32]: ' + bytesToHex(decBytes, 32) + '\n';
      }
    } catch (e: any) { text += 'AES-CTR failed: ' + e.message + '\n'; }

    text += '\n=== Web Crypto: AES-256-CTR decrypt tail (zero IV) ===\n';
    try {
      const uaEnc = new TextEncoder().encode(MEGAUP_UA);
      const uaHash = await crypto.subtle.digest('SHA-256', uaEnc);
      const key = await crypto.subtle.importKey('raw', uaHash, { name: 'AES-CTR' }, false, ['decrypt']);
      const zeroIv = new Uint8Array(16);
      for (const s of collected) {
        const tailLen = Math.floor(s.tail.length / 16) * 16;
        if (tailLen < 16) { text += s.label + ': tail too short\n'; continue; }
        const decrypted = await crypto.subtle.decrypt(
          { name: 'AES-CTR', counter: zeroIv, length: 128 }, key, s.tail.subarray(0, tailLen));
        const decBytes = new Uint8Array(decrypted);
        text += s.label + ' dec[0:32]: ' + bytesToHex(decBytes, 32) + '\n';
      }
    } catch (e: any) { text += 'AES-CTR zero-iv: ' + e.message + '\n'; }

    text += '\n=== Web Crypto: AES-256-CTR generate ks from video ID ===\n';
    text += 'Hypothesis: ks = AES-CTR(key=H(UA), iv=H(videoID)[0:16])\n';
    try {
      const uaEnc = new TextEncoder().encode(MEGAUP_UA);
      const uaHash = await crypto.subtle.digest('SHA-256', uaEnc);
      const key = await crypto.subtle.importKey('raw', uaHash, { name: 'AES-CTR' }, false, ['encrypt']);
      for (const s of collected) {
        const vidEnc = new TextEncoder().encode(s.id);
        const vidHash = await crypto.subtle.digest('SHA-256', vidEnc);
        const iv = new Uint8Array(vidHash).subarray(0, 16);
        const plaintext = new Uint8Array(Math.min(s.ks.length, 256));
        const generated = await crypto.subtle.encrypt(
          { name: 'AES-CTR', counter: iv, length: 128 }, key, plaintext);
        const genBytes = new Uint8Array(generated);
        let matches = 0;
        for (let i = 0; i < genBytes.length; i++) { if (genBytes[i] === s.ks[i]) matches++; }
        text += s.label + ': ' + matches + '/' + genBytes.length + ' match\n';
        text += '  gen[0:32]: ' + bytesToHex(genBytes, 32) + '\n';
        text += '  ks [0:32]: ' + bytesToHex(s.ks, 32) + '\n';
      }
    } catch (e: any) { text += 'ks gen test failed: ' + e.message + '\n'; }

    text += '\n=== Algorithm Summary ===\n';
    text += 'Common prefix: ' + firstDiff + 'B (UA-derived constant)\n';
    text += 'Video-specific region: ' + (minKsLen - firstDiff) + 'B\n';
    text += 'Tail size: ' + s0.tail.length + 'B (likely contains encrypted seed)\n';
    text += 'If AES-CTR with correct key works: tail decrypts to keystream suffix\n';
    text += 'If not: algorithm may use different cipher or key derivation\n';

    log(text);
    setAnalysis(text);
  }

  // ── Paste JSON (bypasses CORS/Origin issues entirely) ─────────

  const [pastedJson, setPastedJson] = useState('');
  const [pastedLabel, setPastedLabel] = useState('');

  async function processPastedJson() {
    if (!pastedJson.trim()) { log('Paste the JSON response first.'); return; }
    setStatus('');
    setAnalysis('');
    setRunning(true);

    try {
      let json: any;
      try {
        json = JSON.parse(pastedJson.trim());
      } catch {
        log('Invalid JSON. Copy the ENTIRE response from the browser tab.');
        setRunning(false);
        return;
      }

      if (!json.result) {
        log('No "result" field in JSON. Make sure the URL is /media/VIDEO_ID not /e/VIDEO_ID.');
        setRunning(false);
        return;
      }

      const encB64 = json.result;
      const encBytes = b64decode(encB64);
      log('Encrypted: ' + encBytes.length + ' bytes');
      log('Result (first 80): ' + encB64.substring(0, 80) + '...');

      log('Calling enc-dec.app...');
      const decRes = await fetch(ENCDEC_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: encB64, agent: MEGAUP_UA }),
        signal: AbortSignal.timeout(15000),
      });

      if (!decRes.ok) throw new Error('enc-dec HTTP ' + decRes.status);
      const decData = await decRes.json();
      if (decData.status !== 200 || !decData.result) throw new Error('enc-dec no result');

      const plainStr = typeof decData.result === 'string' ? decData.result : JSON.stringify(decData.result);
      const plainBytes = new TextEncoder().encode(plainStr);
      log('Plaintext: ' + plainBytes.length + ' bytes');
      log('Preview: ' + plainStr.substring(0, 200));

      const ciphertext = encBytes.subarray(0, plainBytes.length);
      const tail = encBytes.subarray(plainBytes.length);
      log('Ciphertext: ' + ciphertext.length + 'B, Tail: ' + tail.length + 'B');

      const ks = xorBytes(ciphertext, plainBytes);
      log('Keystream: ' + ks.length + ' bytes');
      log('KS[0:40]: ' + bytesToHex(ks.subarray(0, 40)));

      const label = pastedLabel.trim() || ('Pasted-' + Date.now().toString(36));
      const id = label; // use label as id for pasted samples

      // Save to localStorage
      const stored = JSON.parse(localStorage.getItem('megaup-samples') || '[]');
      stored.push({ id, host: 'pasted', label, encB64, plainStr, ksHex: bytesToHex(ks), tailHex: bytesToHex(tail) });
      localStorage.setItem('megaup-samples', JSON.stringify(stored));
      log('\nSaved! Total stored: ' + stored.length + '. Paste another, then "Compare from Storage".');
    } catch (e: any) {
      log('FAILED: ' + e.message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ fontFamily: 'monospace', maxWidth: 1200, margin: '0 auto', padding: 20, color: '#e0e0e0', background: '#111', minHeight: '100vh' }}>
      <h1 style={{ color: '#6366f1', marginBottom: 0 }}>MegaUp Keystream Analyzer</h1>
      <p style={{ color: '#888', marginTop: 4, marginBottom: 16 }}>
        Step 1: <b>Run Diagnostics</b> to check connectivity.<br/>
        Step 2: Collect 2+ video samples (from the app or custom).<br/>
        Step 3: Run comparison to analyze keystream derivation.
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={runDiagnostics} disabled={running}
          style={{ padding: '10px 20px', cursor: running ? 'default' : 'pointer',
            background: running ? '#444' : '#f59e0b', color: '#111', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 'bold' }}>
          Step 1: Run Diagnostics
        </button>
        <button onClick={runWithHardcoded} disabled={running}
          style={{ padding: '10px 20px', cursor: running ? 'default' : 'pointer',
            background: running ? '#444' : '#6366f1', color: 'white', border: 'none', borderRadius: 6, fontSize: 14 }}>
          Step 2a: Hardcoded IDs
        </button>
        <button onClick={runFromStorage} disabled={running}
          style={{ padding: '10px 20px', cursor: running ? 'default' : 'pointer',
            background: running ? '#444' : '#22c55e', color: 'white', border: 'none', borderRadius: 6, fontSize: 14 }}>
          Step 3: Compare from Storage
        </button>
      </div>

      <div style={{ background: '#1a1a1a', padding: 14, borderRadius: 8, marginBottom: 16, border: '1px solid #333' }}>
        <strong style={{ color: '#888', fontSize: 13 }}>Step 2b: Custom Video ID</strong>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <input value={videoIdInput} onChange={e => setVideoIdInput(e.target.value)}
            placeholder="Video ID from /e/VIDEO_ID"
            style={{ padding: '5px 8px', flex: 1, minWidth: 280, background: '#222', color: '#fff', border: '1px solid #555', borderRadius: 4, fontSize: 12 }} />
          <input value={hostInput} onChange={e => setHostInput(e.target.value)}
            placeholder="Host"
            style={{ padding: '5px 8px', width: 170, background: '#222', color: '#fff', border: '1px solid #555', borderRadius: 4, fontSize: 12 }} />
          <button onClick={runWithCustom} disabled={running}
            style={{ padding: '5px 14px', cursor: running ? 'default' : 'pointer',
              background: running ? '#444' : '#a855f7', color: 'white', border: 'none', borderRadius: 4, fontSize: 12 }}>
            Process &amp; Save
          </button>
        </div>
      </div>

      <div style={{ background: '#1a1a2e', padding: 14, borderRadius: 8, marginBottom: 16, border: '1px solid #6366f1' }}>
        <strong style={{ color: '#a5b4fc', fontSize: 13 }}>Step 2c: Paste Raw JSON (bypasses CORS)</strong>
        <p style={{ color: '#888', fontSize: 11, margin: '4px 0' }}>
          Open these in new tabs, copy ALL the JSON, paste below:<br/>
          <a href="https://megaup22.online/media/jIrrLzj-WS2JcOLzF79O5xvpCQ" target="_blank" style={{ color: '#6366f1' }}>OPM E1 Sub</a>
          {' | '}
          <a href="https://megaup22.online/media/jKfJZ2GHWS2JcOLzF79M6RvpCQ" target="_blank" style={{ color: '#6366f1' }}>OPM E1 Dub</a>
          {' | '}
          <a href="https://megaup22.online/media/k5OoeWapWS2JcOLzF79O5xvpCQ" target="_blank" style={{ color: '#6366f1' }}>Naruto E1</a>
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <textarea value={pastedJson} onChange={e => setPastedJson(e.target.value)}
            placeholder='Paste the full JSON response here ({"status":200,"result":"..."})'
            rows={4}
            style={{ padding: '5px 8px', flex: 1, minWidth: 400, background: '#111', color: '#fff', border: '1px solid #555', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', resize: 'vertical' }} />
          <input value={pastedLabel} onChange={e => setPastedLabel(e.target.value)}
            placeholder="Label (e.g. OPM-E1-Sub)"
            style={{ padding: '5px 8px', width: 180, background: '#111', color: '#fff', border: '1px solid #555', borderRadius: 4, fontSize: 12, alignSelf: 'flex-start' }} />
          <button onClick={processPastedJson} disabled={running}
            style={{ padding: '5px 14px', cursor: running ? 'default' : 'pointer',
              background: running ? '#444' : '#f59e0b', color: '#111', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 'bold', alignSelf: 'flex-start' }}>
            Process Pasted JSON
          </button>
        </div>
      </div>

      <pre ref={logRef} style={{
        background: '#1a1a1a', padding: 16, borderRadius: 8,
        maxHeight: 500, overflow: 'auto', fontSize: 12, lineHeight: 1.45,
        border: '1px solid #333', whiteSpace: 'pre-wrap',
      }}>
        {status || 'Click "Run Diagnostics" to test connectivity first.'}
      </pre>

      {analysis && (
        <div style={{ marginTop: 20 }}>
          <h2 style={{ color: '#6366f1' }}>Analysis Results</h2>
          <pre style={{
            background: '#1a1a2e', padding: 16, borderRadius: 8,
            fontSize: 13, lineHeight: 1.5, border: '1px solid #6366f1',
            whiteSpace: 'pre-wrap', color: '#c0c0ff',
          }}>
            {analysis}
          </pre>
        </div>
      )}
    </div>
  );
}
