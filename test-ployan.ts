import { config } from 'dotenv';
config(); // Load .env file

import { PloyanProvider } from './app/lib/providers/ployan';

async function run() {
    console.log("Starting Ployan Provider Test...");
    const provider = new PloyanProvider();
    
    console.log(`Configured URL: ${process.env.PLOYAN_EXTRACTOR_URL}`);
    
    try {
        const result = await provider.extract({
            tmdbId: "1630861520",
            mediaType: "tv",
            season: 3,
            episode: 1,
            title: "house-of-the-dragon"
        });
        
        console.log("\n==================================");
        console.log("EXTRACTION RESULT:");
        console.log(JSON.stringify(result, null, 2));
        console.log("==================================\n");
    } catch (e) {
        console.error("Test failed:", e);
    }
}

run();
