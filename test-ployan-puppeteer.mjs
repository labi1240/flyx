import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

async function run() {
    console.log('Launching browser with stealth plugin...');
    const browser = await puppeteer.launch({ 
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    let m3u8Url = null;
    
    page.on('request', request => {
        const url = request.url();
        if (url.includes('.m3u8')) {
            console.log('\n🔥 BOOM! CAUGHT M3U8 REQUEST!');
            console.log('URL:', url);
            m3u8Url = url;
        }
    });

    const targetUrl = 'https://ww2.yesmovies.ag/movie/house-of-the-dragon-season-3-1630861520.html';
    console.log(`Navigating to ${targetUrl}...`);
    
    try {
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('Page loaded! Bypassing UI and injecting JS to trigger video load...');
        
        // Use the site's own jQuery to trigger the episode click, which loads the iframe
        await page.evaluate(async () => {
            // Wait for jQuery to be available
            if (typeof window.$ !== 'undefined') {
                // Click the player collapse button
                window.$('.bwac-btn').click();
                
                // Force click the first episode of server 1
                window.$('.ep-item[data-server="1"]').first().click();
                
                console.log("Injected clicks executed.");
            }
        });
        
        console.log('Waiting 15 seconds for video player iframe to initialize and fetch m3u8...');
        await new Promise(r => setTimeout(r, 15000));
        
        if (m3u8Url) {
            console.log('🎉 Successfully intercepted m3u8 link!');
        } else {
            console.log('Still no m3u8. Taking a screenshot of the player area.');
            await page.screenshot({ path: 'yesmovies-stealth-3.png' });
        }
    } catch (e) {
        console.error('Error during automation:', e);
    } finally {
        await browser.close();
        console.log('Browser closed.');
    }
}

run().catch(console.error);
