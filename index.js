const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();

// Úplně otevřené CORS pro maximální kompatibilitu
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['*'],
    credentials: false,
    optionsSuccessStatus: 200
}));

// Middleware pro explicitní CORS hlavičky na všech responses
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Max-Age', '86400');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;

// RealDebrid API klíč z environment variable
let REAL_DEBRID_API_KEY = process.env.REAL_DEBRID_API_KEY || '';

console.log('🔑 RealDebrid API klíč:', REAL_DEBRID_API_KEY ? 'NASTAVEN' : 'NENÍ NASTAVEN');

const ADDON_CONFIG = {
    id: 'org.subsplease.stremio',
    version: '1.0.0',
    name: 'SubsPlease Airtime Today',
    description: 'Anime vydané dnes z SubsPlease s automatickými postery',
    logo: 'https://subsplease.org/wp-content/uploads/2019/01/SubsPlease-logo.png',
    background: 'https://subsplease.org/wp-content/uploads/2019/01/SubsPlease-logo-banner.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    catalogs: [{
        type: 'series',
        id: 'subsplease_today',
        name: 'Airtime Today'
    }]
};

let animeCache = { data: [], timestamp: 0, ttl: 14 * 60 * 1000 };

// Keep-alive ping funkce
async function keepAlive() {
    try {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const response = await axios.get(`${baseUrl}/health`, { timeout: 5000 });
        console.log(`🏓 Keep-alive ping úspěšný - Status: ${response.data.status}`);
    } catch (error) {
        console.log(`⚠️ Keep-alive ping selhal:`, error.message);
    }
}

// Spustíme keep-alive ping každých 10 minut
setInterval(keepAlive, 10 * 60 * 1000); // 10 minut = 600,000 ms

async function addMagnetToRealDebrid(magnetUrl) {
    const response = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
        `magnet=${encodeURIComponent(magnetUrl)}`,
        {
            headers: {
                'Authorization': `Bearer ${REAL_DEBRID_API_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );
    return response.data;
}

async function getRealDebridStreamUrl(torrentId, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const torrentInfo = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
                headers: { 'Authorization': `Bearer ${REAL_DEBRID_API_KEY}` }
            });

            if (torrentInfo.data.status === 'downloaded' && torrentInfo.data.links && torrentInfo.data.links.length > 0) {
                const downloadLink = torrentInfo.data.links[0];
                
                const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link',
                    `link=${encodeURIComponent(downloadLink)}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${REAL_DEBRID_API_KEY}`,
                            'Content-Type': 'application/x-www-form-urlencoded'
                        }
                    }
                );
                
                if (unrestrict.data && unrestrict.data.download) {
                    return unrestrict.data.download;
                }
            } else if (torrentInfo.data.status === 'waiting_files_selection') {
                const videoFiles = torrentInfo.data.files.filter(file => 
                    file.path.match(/\.(mkv|mp4|avi)$/i)
                );
                
                if (videoFiles.length > 0) {
                    const largestFile = videoFiles.reduce((prev, current) => 
                        (prev.bytes > current.bytes) ? prev : current
                    );
                    
                    await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${torrentId}`,
                        `files=${largestFile.id}`,
                        {
                            headers: {
                                'Authorization': `Bearer ${REAL_DEBRID_API_KEY}`,
                                'Content-Type': 'application/x-www-form-urlencoded'
                            }
                        }
                    );
                }
            }
            
            if (torrentInfo.data.status !== 'downloaded' && i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return null;
}

async function getAnimePoster(animeName) {
    try {
        // Speciální mapování pro problematické názvy
        const specialMappings = {
            'Kimi to Idol Precure': 'Wonderful Precure',
            'Kimi to Idol PreCure': 'Wonderful Precure',
            'Pretty Cure': 'Precure',
            'PreCure': 'Precure',
            'Shirohiyo': 'Shiro Hiyoko'
        };
        
        // Použijeme mapování pokud existuje
        let searchName = specialMappings[animeName] || animeName;
        
        // Vyčistíme název pro lepší vyhledávání
        searchName = searchName
            .replace(/[^\w\s]/g, ' ')  // Odstraníme speciální znaky
            .replace(/\s+/g, ' ')      // Nahradíme více mezer jednou
            .trim();
        
        const searchQuery = encodeURIComponent(searchName);
        const searchUrl = `https://api.jikan.moe/v4/anime?q=${searchQuery}&limit=3`;
        
        console.log(`Hledám poster pro: "${animeName}" -> "${searchName}"`);
        
        // Retry logika pro rate limiting
        let attempt = 0;
        const maxAttempts = 3;
        
        while (attempt < maxAttempts) {
            try {
                // Náhodné zpoždění 1-3 sekundy pro vyhnutí se rate limitu
                if (attempt > 0) {
                    const delay = Math.random() * 2000 + 1000; // 1-3 sekund
                    await new Promise(resolve => setTimeout(resolve, delay));
                    console.log(`Pokus ${attempt + 1}/3 pro "${animeName}" po ${Math.round(delay)}ms`);
                }
                
                const response = await axios.get(searchUrl, { 
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'SubsPlease-Stremio-Addon/1.0'
                    }
                });
                
                if (response.data && response.data.data && response.data.data.length > 0) {
                    // Pokusíme se najít nejlepší shodu
                    let bestMatch = response.data.data[0];
                    
                    // Pokud máme více výsledků, zkusíme najít lepší shodu
                    if (response.data.data.length > 1) {
                        for (const anime of response.data.data) {
                            const title = anime.title?.toLowerCase() || '';
                            const searchLower = searchName.toLowerCase();
                            
                            // Přesná shoda má přednost
                            if (title.includes(searchLower) || searchLower.includes(title)) {
                                bestMatch = anime;
                                break;
                            }
                        }
                    }
                    
                    const images = bestMatch.images?.jpg;
                    const posterUrl = images?.large_image_url || images?.image_url;
                    
                    if (posterUrl) {
                        console.log(`✅ Poster nalezen pro "${animeName}": ${posterUrl}`);
                        return {
                            poster: posterUrl,
                            background: posterUrl
                        };
                    }
                }
                
                break; // Úspěšný požadavek, ale žádný výsledek
                
            } catch (error) {
                attempt++;
                
                if (error.response?.status === 429) {
                    console.log(`⏳ Rate limit pro "${animeName}", pokus ${attempt}/${maxAttempts}`);
                    
                    if (attempt >= maxAttempts) {
                        console.log(`❌ Max pokusy vyčerpány pro "${animeName}"`);
                        break;
                    }
                    // Pokračujeme s dalším pokusem
                    continue;
                } else {
                    console.log(`❌ Chyba při hledání posteru pro "${animeName}":`, error.message);
                    break;
                }
            }
        }
        
        console.log(`⚠️ Poster nenalezen pro "${animeName}", používám fallback`);
    } catch (error) {
        console.log(`❌ Obecná chyba pro "${animeName}":`, error.message);
    }
    
    // Fallback poster
    return {
        poster: 'https://via.placeholder.com/300x400/1a1a2e/ffffff?text=SubsPlease',
        background: 'https://via.placeholder.com/1920x1080/1a1a2e/ffffff?text=SubsPlease'
    };
}

async function getTodayAnime() {
    const now = Date.now();
    if (animeCache.data.length > 0 && (now - animeCache.timestamp) < animeCache.ttl) {
        return animeCache.data;
    }
    
    try {
        console.log('📡 Načítám dnešní anime z RSS...');
        
        const rssUrls = [
            { url: 'https://subsplease.org/rss/?t&r=1080', quality: '1080p' },
            { url: 'https://subsplease.org/rss/?t&r=720', quality: '720p' }
        ];
        
        const animeMap = new Map();
        let totalProcessed = 0;
        
        for (const rss of rssUrls) {
            try {
                console.log(`📥 Stahování ${rss.quality}:`, rss.url);
                
                const response = await axios.get(rss.url, {
                    timeout: 15000,
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/rss+xml, application/xml, text/xml',
                        'Accept-Encoding': 'gzip, deflate'
                    },
                    responseType: 'text'
                });
                
                console.log(`✅ Response ${rss.quality}: ${response.status}, délka: ${response.data?.length || 0}`);
                
                if (!response.data || typeof response.data !== 'string') {
                    console.log(`⚠️ ${rss.quality}: Neplatná RSS data`);
                    continue;
                }
                
                const $ = cheerio.load(response.data, { xmlMode: true });
                
                const items = $('item');
                console.log(`📊 ${rss.quality}: Nalezeno ${items.length} položek v RSS`);
                
                items.each((index, element) => {
                    const title = $(element).find('title').text().trim();
                    const link = $(element).find('link').text().trim();
                    const pubDate = $(element).find('pubDate').text().trim();
                    
                    if (!title || !pubDate) return;
                    
                    const releaseDate = new Date(pubDate);
                    const today = new Date();
                    
                    // Zkontrolujeme posledních 24 hodin místo jen dnešního dne
                    const hoursDiff = (today - releaseDate) / (1000 * 60 * 60);
                    const isRecent = hoursDiff <= 24 && hoursDiff >= 0;
                    
                    if (isRecent) {
                        const match = title.match(/\[SubsPlease\]\s*(.+?)\s*-\s*(\d+(?:\.\d+)?)/);
                        if (match) {
                            const animeName = match[1].trim();
                            const episode = match[2];
                            const animeKey = `${animeName}-${episode}`;
                            
                            totalProcessed++;
                            
                            if (!animeMap.has(animeKey)) {
                                animeMap.set(animeKey, {
                                    id: `subsplease:${Buffer.from(animeKey).toString('base64')}`,
                                    name: animeName,
                                    episode: episode,
                                    fullTitle: title,
                                    poster: null,
                                    background: null,
                                    releaseInfo: releaseDate.toLocaleDateString('cs-CZ'),
                                    type: 'series',
                                    pubDate: pubDate,
                                    qualities: new Map()
                                });
                                console.log(`🎌 Nové anime: ${animeName} - Episode ${episode}`);
                            }
                            
                            animeMap.get(animeKey).qualities.set(rss.quality, link);
                        }
                    }
                });
                
            } catch (error) {
                console.log(`❌ Chyba při načítání ${rss.quality}:`, error.message);
            }
        }
        
        console.log(`📈 Celkem zpracováno: ${totalProcessed} položek, unikátních anime: ${animeMap.size}`);
        
        let animeList = Array.from(animeMap.values());
        
        // Pokud nemáme dnešní anime, vytvoříme demo data
        if (animeList.length === 0) {
            console.log('⚠️ Žádné dnešní anime nenalezeno, používám demo data');
            animeList = [
                {
                    id: 'subsplease:' + Buffer.from('Demo Anime-1').toString('base64'),
                    name: 'Demo Anime - Žádné dnešní vydání',
                    episode: '1',
                    fullTitle: '[SubsPlease] Demo Anime - 01 (1080p)',
                    poster: 'https://via.placeholder.com/300x400/1a1a2e/ffffff?text=Žádné+anime+dnes',
                    background: 'https://via.placeholder.com/1920x1080/1a1a2e/ffffff?text=Demo+Background',
                    releaseInfo: new Date().toLocaleDateString('cs-CZ'),
                    type: 'series',
                    pubDate: new Date().toISOString(),
                    qualities: new Map([['1080p', 'https://subsplease.org/'], ['720p', 'https://subsplease.org/']])
                }
            ];
        } else {
            // Načteme postery postupně s malým zpožděním
            console.log('🖼️ Načítám postery...');
            const animeWithPosters = [];
            
            for (let i = 0; i < animeList.length; i++) {
                const anime = animeList[i];
                
                // Malé zpoždění mezi požadavky (200-500ms)
                if (i > 0) {
                    const delay = Math.random() * 300 + 200;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                
                const images = await getAnimePoster(anime.name);
                animeWithPosters.push({
                    ...anime,
                    poster: images.poster,
                    background: images.background
                });
            }
            
            animeList = animeWithPosters;
        }

        animeCache.data = animeList;
        animeCache.timestamp = now;
        
        console.log(`✅ Cache aktualizován s ${animeList.length} anime`);
        return animeList;
        
    } catch (error) {
        console.log('❌ Globální chyba při načítání anime:', error.message);
        
        // Fallback demo data
        const demoData = [{
            id: 'subsplease:' + Buffer.from('Error Demo-1').toString('base64'),
            name: 'Chyba při načítání RSS',
            episode: '1',
            fullTitle: '[SubsPlease] Error Demo - 01 (1080p)',
            poster: 'https://via.placeholder.com/300x400/dc3545/ffffff?text=RSS+Error',
            background: 'https://via.placeholder.com/1920x1080/dc3545/ffffff?text=RSS+Error',
            releaseInfo: 'Error',
            type: 'series',
            pubDate: new Date().toISOString(),
            qualities: new Map([['1080p', 'https://subsplease.org/'], ['720p', 'https://subsplease.org/']])
        }];
        
        animeCache.data = demoData;
        animeCache.timestamp = now;
        return demoData;
    }
}

async function getMagnetLinks(pageUrl, anime, quality = '1080p') {
    try {
        let targetUrl = pageUrl;
        if (anime.qualities && anime.qualities.has(quality)) {
            targetUrl = anime.qualities.get(quality);
        }
        
        if (targetUrl && targetUrl.includes('nyaa.si/view/')) {
            const nyaaResponse = await axios.get(targetUrl.replace('/torrent', ''), {
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            
            const $ = cheerio.load(nyaaResponse.data);
            const magnetEl = $('a[href^="magnet:"]');
            
            if (magnetEl.length > 0) {
                const magnetUrl = magnetEl.attr('href');
                if (magnetUrl) {
                    return [{
                        magnet: magnetUrl,
                        quality: quality,
                        title: `[SubsPlease] ${anime.name} - ${anime.episode} (${quality})`
                    }];
                }
            }
        }

        const hash = anime.fullTitle?.match(/\[([A-F0-9]{8})\]/)?.[1]?.padEnd(40, '0') || '1'.repeat(40);
        const magnetUrl = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(`[SubsPlease] ${anime.name} - ${anime.episode} (${quality})`)}&tr=http://nyaa.tracker.wf:7777/announce`;
        
        return [{
            magnet: magnetUrl,
            quality: quality,
            title: `[SubsPlease] ${anime.name} - ${anime.episode} (${quality})`
        }];
    } catch (error) {
        return [];
    }
}

// Helper funkce pro JSON response s CORS
function sendJsonWithCors(res, data, status = 200) {
    res.status(status);
    res.header('Content-Type', 'application/json; charset=utf-8');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json(data);
}

// Routes
app.get('/', (req, res) => {
    const baseUrl = req.protocol + '://' + req.get('host');
    
    res.send(`<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SubsPlease Stremio Addon</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh; padding: 20px; color: white;
        }
        .container {
            max-width: 800px; margin: 0 auto;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px; padding: 40px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.3);
        }
        .header { text-align: center; margin-bottom: 40px; }
        .logo {
            width: 80px; height: 80px;
            background: linear-gradient(45deg, #ff6b6b, #ffd93d);
            border-radius: 20px; margin: 0 auto 20px;
            display: flex; align-items: center; justify-content: center;
            font-size: 36px; color: white;
        }
        h1 { margin-bottom: 10px; font-size: 2.5rem; }
        .subtitle { font-size: 1.1rem; opacity: 0.9; }
        .status {
            padding: 20px; margin: 20px 0; border-radius: 15px;
            text-align: center; font-weight: 500;
        }
        .status.ok { background: rgba(40, 167, 69, 0.2); border: 2px solid #28a745; }
        .status.error { background: rgba(220, 53, 69, 0.2); border: 2px solid #dc3545; }
        .install-section {
            background: rgba(255, 255, 255, 0.1);
            padding: 30px; border-radius: 15px; margin: 30px 0;
            text-align: center;
        }
        .url-box {
            background: rgba(0,0,0,0.3); padding: 15px; 
            border-radius: 8px; margin: 15px 0;
            word-break: break-all; font-family: monospace;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .btn {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white; border: none; padding: 12px 24px;
            border-radius: 10px; font-size: 16px; font-weight: 500;
            cursor: pointer; margin: 10px; text-decoration: none;
            display: inline-block; transition: transform 0.2s;
        }
        .btn:hover { transform: translateY(-2px); }
        .features {
            background: rgba(255, 193, 7, 0.1);
            padding: 20px; border-radius: 10px; margin: 20px 0;
            border: 1px solid rgba(255, 193, 7, 0.3);
        }
        .keepalive-info {
            background: rgba(0, 255, 127, 0.1);
            padding: 15px; border-radius: 10px; margin: 20px 0;
            border: 1px solid rgba(0, 255, 127, 0.3);
            text-align: center; font-size: 14px;
        }

    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🍜</div>
            <h1>SubsPlease Stremio</h1>
            <p class="subtitle">Airtime Today - dnešní anime s RealDebrid podporou</p>
        </div>

        <div class="status ${REAL_DEBRID_API_KEY ? 'ok' : 'error'}">
            ${REAL_DEBRID_API_KEY ? 
                '✅ RealDebrid API klíč je nakonfigurován' : 
                '⚠️ RealDebrid API klíč není nastaven - kontaktujte administrátora'
            }
        </div>

        <div class="keepalive-info">
            🏓 <strong>Keep-Alive aktivní:</strong> Server se automaticky pinguje každých 10 minut<br>
            aby se na Render.com neuspal po 15 minutách nečinnosti
        </div>

        <div class="install-section">
            <h2>📱 Instalace do Stremio</h2>
            <div class="url-box">${baseUrl}/manifest.json</div>
            <a href="stremio://${req.get('host')}/manifest.json" class="btn">🚀 Instalovat do Stremio</a>
        </div>



        <div class="features">
            <strong>📺 Funkce addonu:</strong><br>
            • Zobrazuje pouze anime vydané DNES<br>
            • Automatické načítání posterů z MyAnimeList API<br>
            • Kontrola nových anime každých 14 minut<br>
            • RealDebrid streaming s direct links<br>
            • Podpora pro 1080p a 720p rozlišení<br>
            • Keep-alive systém proti uspávání na Render.com<br>
            • Rozšířené CORS pro Stremio web kompatibilitu
        </div>
    </div>
</body>
</html>`);
});

// Manifest s robustním error handlingem
app.get('/manifest.json', (req, res) => {
    try {
        console.log('📋 Manifest request from:', req.get('User-Agent'));
        sendJsonWithCors(res, ADDON_CONFIG);
    } catch (error) {
        console.error('❌ Manifest error:', error);
        sendJsonWithCors(res, { error: 'Manifest error' }, 500);
    }
});

app.get('/catalog/:type/:id.json', async (req, res) => {
    try {
        console.log('📚 Catalog request:', req.params.id);
        
        if (req.params.id === 'subsplease_today') {
            const animeList = await getTodayAnime();
            
            const metas = animeList.map(anime => ({
                id: anime.id,
                type: 'series',
                name: anime.name,
                poster: anime.poster,
                background: anime.background,
                description: `Epizoda ${anime.episode} - ${anime.releaseInfo}`,
                genres: ['Anime'],
                year: new Date().getFullYear(),
                imdbRating: 8.0,
                releaseInfo: anime.releaseInfo
            }));

            sendJsonWithCors(res, { metas });
        } else {
            sendJsonWithCors(res, { metas: [] });
        }
    } catch (error) {
        console.error('❌ Catalog error:', error);
        sendJsonWithCors(res, { 
            metas: [],
            error: 'Chyba při načítání katalogu'
        }, 500);
    }
});

app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    try {
        if (req.params.id === 'subsplease_today') {
            const animeList = await getTodayAnime();
            
            const metas = animeList.map(anime => ({
                id: anime.id,
                type: 'series',
                name: anime.name,
                poster: anime.poster,
                background: anime.background,
                description: `Epizoda ${anime.episode} - ${anime.releaseInfo}`,
                genres: ['Anime'],
                year: new Date().getFullYear(),
                imdbRating: 8.0,
                releaseInfo: anime.releaseInfo
            }));

            sendJsonWithCors(res, { metas });
        } else {
            sendJsonWithCors(res, { metas: [] });
        }
    } catch (error) {
        sendJsonWithCors(res, { 
            metas: [],
            error: 'Chyba při načítání katalogu'
        }, 500);
    }
});

app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        const animeId = req.params.id;
        
        if (animeId.startsWith('subsplease:')) {
            const animeList = await getTodayAnime();
            const anime = animeList.find(a => a.id === animeId);
            
            if (anime) {
                sendJsonWithCors(res, {
                    meta: {
                        id: anime.id,
                        type: 'series',
                        name: anime.name,
                        poster: anime.poster,
                        background: anime.background,
                        description: `${anime.fullTitle}\n\nVydáno: ${anime.releaseInfo}`,
                        releaseInfo: anime.releaseInfo,
                        year: new Date().getFullYear(),
                        imdbRating: 8.0,
                        genres: ['Anime'],
                        videos: [{
                            id: `${anime.id}:1:${anime.episode}`,
                            title: `Epizoda ${anime.episode}`,
                            season: 1,
                            episode: parseInt(anime.episode),
                            released: anime.pubDate ? new Date(anime.pubDate) : new Date(),
                            overview: anime.fullTitle,
                            thumbnail: anime.poster
                        }]
                    }
                });
            } else {
                sendJsonWithCors(res, { error: 'Anime nenalezeno' }, 404);
            }
        } else {
            sendJsonWithCors(res, { error: 'Neplatné ID' }, 404);
        }
    } catch (error) {
        sendJsonWithCors(res, { error: 'Chyba serveru' }, 500);
    }
});

app.get('/stream/:type/:id.json', async (req, res) => {
    try {
        const videoId = req.params.id;
        const parts = videoId.split(':');
        const animeId = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : videoId;
        
        if (animeId.startsWith('subsplease:')) {
            const animeList = await getTodayAnime();
            const anime = animeList.find(a => a.id === animeId);
            
            if (anime) {
                const streams = [];
                
                if (!REAL_DEBRID_API_KEY) {
                    streams.push({
                        name: '🔑 RealDebrid vyžadován',
                        title: 'Kontaktujte administrátora pro nastavení RealDebrid API',
                        url: req.protocol + '://' + req.get('host')
                    });
                } else {
                    const availableQualities = anime.qualities ? Array.from(anime.qualities.keys()) : ['1080p'];
                    
                    for (const quality of availableQualities) {
                        const magnetLinks = await getMagnetLinks(null, anime, quality);
                        
                        for (const magnet of magnetLinks) {
                            try {
                                const rdResponse = await addMagnetToRealDebrid(magnet.magnet);
                                if (rdResponse?.id) {
                                    const streamUrl = await getRealDebridStreamUrl(rdResponse.id);
                                    
                                    if (streamUrl) {
                                        streams.push({
                                            name: `🚀 RealDebrid ${quality}`,
                                            title: magnet.title,
                                            url: streamUrl,
                                            behaviorHints: {
                                                bingeGroup: `subsplease-${anime.name}`,
                                                notWebReady: false
                                            }
                                        });
                                    } else {
                                        streams.push({
                                            name: `🚀 RealDebrid ${quality} (Processing...)`,
                                            title: `${magnet.title} - Torrent ID: ${rdResponse.id}`,
                                            url: magnet.magnet,
                                            behaviorHints: {
                                                bingeGroup: `subsplease-${anime.name}`,
                                                notWebReady: true
                                            }
                                        });
                                    }
                                }
                            } catch (error) {
                                streams.push({
                                    name: `⚡ ${quality} (Magnet)`,
                                    title: magnet.title,
                                    url: magnet.magnet,
                                    behaviorHints: {
                                        bingeGroup: `subsplease-${anime.name}`,
                                        notWebReady: true
                                    }
                                });
                            }
                        }
                    }
                }

                if (streams.length === 0) {
                    streams.push({
                        name: '⚠️ Není k dispozici',
                        title: 'Stream není momentálně dostupný',
                        url: 'https://subsplease.org'
                    });
                }

                sendJsonWithCors(res, { streams });
            } else {
                sendJsonWithCors(res, { streams: [{ name: '❌ Anime nenalezeno', url: 'https://subsplease.org' }] });
            }
        } else {
            sendJsonWithCors(res, { streams: [] });
        }
    } catch (error) {
        sendJsonWithCors(res, { 
            streams: [{ name: '❌ Chyba', url: 'https://subsplease.org' }]
        }, 500);
    }
});

app.get('/health', (req, res) => {
    sendJsonWithCors(res, {
        status: 'ok',
        timestamp: new Date().toISOString(),
        realDebridConfigured: !!REAL_DEBRID_API_KEY,
        cacheSize: animeCache.data.length,
        cacheAge: Date.now() - animeCache.timestamp,
        keepAlive: true,
        cors: 'enabled'
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SubsPlease Stremio addon běží na portu ${PORT}`);
    console.log(`⏰ Cache interval: 14 minut`);
    console.log(`🏓 Keep-alive ping: každých 10 minut`);
    console.log(`🔑 RealDebrid API klíč:`, REAL_DEBRID_API_KEY ? 'NASTAVEN' : 'NENÍ NASTAVEN');
    console.log(`🌐 CORS je nastaven pro Stremio web`);
    
    // Spustíme první ping po 5 minutách od startu
    setTimeout(() => {
        console.log(`🏓 Spouštím keep-alive systém...`);
        keepAlive(); // První ping
    }, 5 * 60 * 1000); // 5 minut po startu
});