const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
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

// Funkce pro vytvoření "Dnes zatím nic nevyšlo" položky
function createNoAnimeToday() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('cs-CZ', { 
        hour: '2-digit', 
        minute: '2-digit',
        timeZone: 'Europe/Prague'
    });
    
    return {
        id: 'subsplease:no-anime-today',
        name: `Dnes zatím nic nevyšlo (${timeString})`,
        episode: '0',
        fullTitle: `Dnes zatím nevyšlo žádné anime - ${timeString}`,
        poster: 'https://via.placeholder.com/300x400/2c3e50/ffffff?text=🕐+Zatím+nic',
        background: 'https://via.placeholder.com/1920x1080/2c3e50/ffffff?text=Dnes+zatím+nic+nevyšlo',
        releaseInfo: `Aktualizováno: ${timeString}`,
        type: 'series',
        pubDate: now.toISOString(),
        qualities: new Map(),
        isPlaceholder: true
    };
}

async function getTodayAnime() {
    const now = Date.now();
    if (animeCache.data.length > 0 && (now - animeCache.timestamp) < animeCache.ttl) {
        return animeCache.data;
    }
    
    try {
        const rssUrls = [
            { url: 'https://subsplease.org/rss/?t&r=1080', quality: '1080p' },
            { url: 'https://subsplease.org/rss/?t&r=720', quality: '720p' }
        ];
        
        const animeMap = new Map();
        
        for (const rss of rssUrls) {
            try {
                const response = await axios.get(rss.url, {
                    timeout: 10000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });
                
                const $ = cheerio.load(response.data, { xmlMode: true });
                
                $('item').each((index, element) => {
                    const title = $(element).find('title').text().trim();
                    const link = $(element).find('link').text().trim();
                    const pubDate = $(element).find('pubDate').text().trim();
                    
                    const releaseDate = new Date(pubDate);
                    const today = new Date();
                    const isToday = releaseDate.toDateString() === today.toDateString();
                    
                    if (isToday) {
                        const match = title.match(/\[SubsPlease\]\s*(.+?)\s*-\s*(\d+(?:\.\d+)?)/);
                        if (match) {
                            const animeName = match[1].trim();
                            const episode = match[2];
                            const animeKey = `${animeName}-${episode}`;
                            
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
                                    qualities: new Map(),
                                    isPlaceholder: false
                                });
                            }
                            
                            animeMap.get(animeKey).qualities.set(rss.quality, link);
                        }
                    }
                });
                
            } catch (error) {
                console.log(`Chyba při načítání ${rss.quality}:`, error.message);
            }
        }
        
        let animeList = Array.from(animeMap.values());

        // Pokud nenalezeno žádné anime dnes, přidáme placeholder
        if (animeList.length === 0) {
            console.log('📭 Dnes zatím nevyšlo žádné anime, přidávám placeholder');
            animeList = [createNoAnimeToday()];
            
            // Uložíme do cache s kratším TTL (5 minut) pro častější aktualizace
            animeCache.data = animeList;
            animeCache.timestamp = now;
            
            return animeList;
        }

        const animeWithPosters = [];
        
        // Načteme postery postupně s malým zpožděním
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

        animeCache.data = animeWithPosters;
        animeCache.timestamp = now;
        return animeWithPosters;
        
    } catch (error) {
        console.log('❌ Chyba při načítání anime, používám fallback:', error.message);
        
        // Fallback - pokud selže vše, vrátíme placeholder
        const fallbackList = [createNoAnimeToday()];
        animeCache.data = fallbackList;
        animeCache.timestamp = now;
        
        return fallbackList;
    }
}

async function getMagnetLinks(pageUrl, anime, quality = '1080p') {
    // Pokud je to placeholder, vracíme prázdné pole
    if (anime.isPlaceholder) {
        return [];
    }
    
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
            • Pokud dnes nic nevyšlo, zobrazí se "Dnes zatím nic nevyšlo" s aktuálním časem<br>
            • Automatické načítání posterů z MyAnimeList API<br>
            • Kontrola nových anime každých 14 minut<br>
            • RealDebrid streaming s direct links<br>
            • Podpora pro 1080p a 720p rozlišení<br>
            • Keep-alive systém proti uspávání na Render.com
        </div>
    </div>
</body>
</html>`);
});

app.get('/manifest.json', (req, res) => res.json(ADDON_CONFIG));

app.get('/catalog/:type/:id.json', async (req, res) => {
    try {
        if (req.params.id === 'subsplease_today') {
            const animeList = await getTodayAnime();
            
            const metas = animeList.map(anime => ({
                id: anime.id,
                type: 'series',
                name: anime.name,
                poster: anime.poster,
                background: anime.background,
                description: anime.isPlaceholder ? 
                    `Zatím dnes nevyšlo žádné anime. Kontrola každých 14 minut.` :
                    `Epizoda ${anime.episode} - ${anime.releaseInfo}`,
                genres: anime.isPlaceholder ? ['Informace'] : ['Anime'],
                year: new Date().getFullYear(),
                imdbRating: anime.isPlaceholder ? 0 : 8.0,
                releaseInfo: anime.releaseInfo
            }));

            res.json({ metas });
        } else {
            res.json({ metas: [] });
        }
    } catch (error) {
        res.status(500).json({ 
            metas: [],
            error: 'Chyba při načítání katalogu'
        });
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
                description: anime.isPlaceholder ? 
                    `Zatím dnes nevyšlo žádné anime. Kontrola každých 14 minut.` :
                    `Epizoda ${anime.episode} - ${anime.releaseInfo}`,
                genres: anime.isPlaceholder ? ['Informace'] : ['Anime'],
                year: new Date().getFullYear(),
                imdbRating: anime.isPlaceholder ? 0 : 8.0,
                releaseInfo: anime.releaseInfo
            }));

            res.json({ metas });
        } else {
            res.json({ metas: [] });
        }
    } catch (error) {
        res.status(500).json({ 
            metas: [],
            error: 'Chyba při načítání katalogu'
        });
    }
});

app.get('/meta/:type/:id.json', async (req, res) => {
    try {
        const animeId = req.params.id;
        
        if (animeId.startsWith('subsplease:')) {
            const animeList = await getTodayAnime();
            const anime = animeList.find(a => a.id === animeId);
            
            if (anime) {
                // Speciální handling pro placeholder
                if (anime.isPlaceholder) {
                    res.json({
                        meta: {
                            id: anime.id,
                            type: 'series',
                            name: anime.name,
                            poster: anime.poster,
                            background: anime.background,
                            description: `Zatím dnes nevyšlo žádné anime ze SubsPlease.\n\nPosledních kontrola: ${anime.releaseInfo}\n\nAddon kontroluje nové releasy každých 14 minut.`,
                            releaseInfo: anime.releaseInfo,
                            year: new Date().getFullYear(),
                            imdbRating: 0,
                            genres: ['Informace'],
                            videos: [{
                                id: `${anime.id}:1:0`,
                                title: 'Zatím žádný obsah',
                                season: 1,
                                episode: 0,
                                released: new Date(anime.pubDate),
                                overview: 'Dnes zatím nevyšlo žádné anime',
                                thumbnail: anime.poster
                            }]
                        }
                    });
                } else {
                    res.json({
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
                }
            } else {
                res.status(404).json({ error: 'Anime nenalezeno' });
            }
        } else {
            res.status(404).json({ error: 'Neplatné ID' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Chyba serveru' });
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
                // Speciální handling pro placeholder
                if (anime.isPlaceholder) {
                    res.json({
                        streams: [{
                            name: '📭 Zatím žádný obsah',
                            title: 'Dnes zatím nevyšlo žádné anime - zkuste to později',
                            url: req.protocol + '://' + req.get('host'),
                            behaviorHints: {
                                notWebReady: true
                            }
                        }]
                    });
                    return;
                }
                
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

                res.json({ streams });
            } else {
                res.json({ streams: [{ name: '❌ Anime nenalezeno', url: 'https://subsplease.org' }] });
            }
        } else {
            res.json({ streams: [] });
        }
    } catch (error) {
        res.status(500).json({ 
            streams: [{ name: '❌ Chyba', url: 'https://subsplease.org' }]
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        realDebridConfigured: !!REAL_DEBRID_API_KEY,
        cacheSize: animeCache.data.length,
        cacheAge: Date.now() - animeCache.timestamp,
        cacheTTL: animeCache.ttl,
        hasPlaceholder: animeCache.data.length > 0 && animeCache.data[0].isPlaceholder,
        keepAlive: true
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SubsPlease Stremio addon běží na portu ${PORT}`);
    console.log(`⏰ Cache interval: 14 minut`);
    console.log(`🏓 Keep-alive ping: každých 10 minut`);
    console.log(`🔑 RealDebrid API klíč:`, REAL_DEBRID_API_KEY ? 'NASTAVEN' : 'NENÍ NASTAVEN');
    
    // Spustíme první ping po 5 minutách od startu
    setTimeout(() => {
        console.log(`🏓 Spouštím keep-alive systém...`);
        keepAlive(); // První ping
    }, 5 * 60 * 1000); // 5 minut po startu
});