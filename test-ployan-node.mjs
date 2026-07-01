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
    console.log("1. Fetching location from YesMovies cdn-cgi/trace...");
    const traceRes = await fetch('https://ww2.yesmovies.ag/cdn-cgi/trace');
    const traceText = await traceRes.text();
    const traceData = Object.fromEntries(traceText.trim().split('\n').map(e => e.split('=')));
    
    const pwd = traceData['loc'];
    console.log(`-> Got location: ${pwd} (IP: ${traceData['ip']})`);
    
    const mid = "1630861520"; // House of the Dragon S3
    const ei = "1"; // Episode 1
    const sv = "1"; // Server 1
    const tsx = Math.floor(Date.now() / 1000);
    
    const payload = `${mid}+${ei}+${sv}+${pwd}+${tsx}`;
    console.log(`2. Encrypting payload: ${payload}`);
    
    const encrypted = await encox(payload, pwd);
    // URL safe base64
    const urix = encodeURIComponent(encrypted);
    
    const plyURL = "https://ployan.me";
    const watchUrl = `${plyURL}/watch/?v${sv}${ei}#${urix}`;
    console.log(`-> Generated URL: ${watchUrl}`);
    
    console.log("3. Fetching Ployan embed URL with correct Referer...");
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://ww2.yesmovies.ag/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };
    
    const response = await fetch(watchUrl, { headers });
    const text = await response.text();
    
    console.log(`-> Response Status: ${response.status}`);
    
    if (text.includes(".m3u8")) {
        console.log("🎉 SUCCESS! Found m3u8 in response!");
        const match = text.match(/(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/);
        if (match) {
            console.log("-> Extracted URL:", match[1]);
        }
    } else {
        console.log("❌ No m3u8 found. Output snippet:");
        console.log(text.substring(0, 500));
        
        // Let's check if there is some packed script or JSON config
        const scripts = text.match(/<script[^>]*>(.*?)<\/script>/gs);
        if (scripts) {
            console.log("\nFound scripts in the response:");
            scripts.forEach((s, i) => {
                if (s.includes('eval') || s.includes('m3u8') || s.includes('playlist')) {
                    console.log(`Script ${i}:`, s.substring(0, 200) + '...');
                }
            });
        }
    }
}

testExtraction().catch(console.error);
