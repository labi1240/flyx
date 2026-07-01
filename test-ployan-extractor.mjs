import crypto from 'crypto';

// Recreate the YesMovies AES-GCM encryption logic
async function encox(plaintext, pwd) {
    const pwUtf8 = new TextEncoder().encode(pwd);
    const pwHash = await crypto.subtle.digest('SHA-256', pwUtf8);
    
    // Generate 12 random bytes for IV
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ivStr = Array.from(iv).map(b => String.fromCharCode(b)).join('');
    
    const alg = { name: 'AES-GCM', iv: iv };
    const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['encrypt']);
    
    const ptUint8 = new TextEncoder().encode(plaintext);
    const ctBuffer = await crypto.subtle.encrypt(alg, key, ptUint8);
    const ctArray = Array.from(new Uint8Array(ctBuffer));
    const ctStr = ctArray.map(byte => String.fromCharCode(byte)).join('');
    
    // btoa equivalent
    return Buffer.from(ivStr + ctStr, 'binary').toString('base64');
}

async function testExtraction() {
    const mid = "1630861520"; // House of the Dragon S3
    const ei = "1"; // Episode 1
    const sv = "1"; // Server 1
    
    // We'll hardcode the IP location to US for testing
    const pwd = "US";
    const tsx = Math.floor(Date.now() / 1000);
    
    const payload = `${mid}+${ei}+${sv}+${pwd}+${tsx}`;
    console.log("Payload:", payload);
    
    const encrypted = await encox(payload, pwd);
    // URL safe base64
    const urix = encodeURIComponent(encrypted);
    
    const plyURL = "https://ployan.me";
    const watchUrl = `${plyURL}/watch/?v${sv}${ei}#${urix}`;
    console.log("Generated URL:", watchUrl);
    
    console.log("Fetching URL...");
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Referer': 'https://ww2.yesmovies.ag/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };
    
    const response = await fetch(watchUrl, { headers });
    const text = await response.text();
    
    console.log(`Response Status: ${response.status}`);
    
    // Check if we got Cloudflare challenge or actual content
    if (text.includes("cloudflare") && response.status === 403) {
        console.log("Cloudflare protection detected!");
    } else {
        // Look for m3u8 in the response
        if (text.includes(".m3u8")) {
            console.log("Found m3u8 in response!");
            const match = text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/);
            if (match) {
                console.log("Extracted URL:", match[1]);
            }
        } else {
            console.log("No m3u8 found. Output snippet:");
            console.log(text.substring(0, 1000));
        }
    }
}

testExtraction().catch(console.error);
