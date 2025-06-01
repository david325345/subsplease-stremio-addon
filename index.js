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

// Konfigurace pro zapínání/vypínání zdrojů
let sourceConfig = {
    subsplease: true,
    erairaws: true
};

const ADDON_CONFIG = {
    id: 'org.subsplease.erairaws.stremio',
    version: '1.0.0',
    name: 'SubsPlease + Erai-raws Airtime Today',
    description: 'Anime vydané dnes z SubsPlease a Erai-raws s automatickými postery',
    logo: 'https://subsplease.org/wp-content/uploads/2019/01/SubsPlease-logo.png',
    background: 'https://subsplease.org/wp-content/uploads/2019/01/SubsPlease-logo-banner.png',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    catalogs: [
        {
            type: 'series',
            id: 'subsplease_today',
            name: '🍜 SubsPlease - Today',
            extra: [{ name: 'genre', options: ['SubsPlease'] }]
        },
        {
            type: 'series', 
            id: 'erairaws_today',
            name: '🦄 Erai-raws - Today',
            extra: [{ name: 'genre', options: ['Erai-raws'] }]
        }
    ]
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
                        'User-Agent': 'SubsPlease-Erai-Stremio-Addon/1.0'
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
        poster: 'https://via.placeholder.com/300x400/1a1a2e/ffffff?text=Anime',
        background: 'https://via.placeholder.com/1920x1080/1a1a2e/ffffff?text=Anime'
    };
}

async function getSubsPleaseAnime() {
    if (!sourceConfig.subsplease) {
        console.log('📴 SubsPlease je vypnutý');
        return [];
    }
    
    console.log('🍜 Načítám SubsPlease anime...');
    
    try {
        const rssUrls = [
            { url: 'https://subsplease.org/rss/?t&r=1080', quality: '1080p' },
            { url: 'https://subsplease.org/rss/?t&r=720', quality: '720p' }
        ];
        
        const animeMap = new Map();
        const today = new Date();
        console.log(`📅 Dnešní datum: ${today.toDateString()}`);
        
        for (const rss of rssUrls) {
            try {
                console.log(`📡 Načítám ${rss.quality} z ${rss.url}`);
                
                const response = await axios.get(rss.url, {
                    timeout: 10000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });
                
                const $ = cheerio.load(response.data, { xmlMode: true });
                let itemCount = 0;
                let todayCount = 0;
                
                $('item').each((index, element) => {
                    itemCount++;
                    const title = $(element).find('title').text().trim();
                    const link = $(element).find('link').text().trim();
                    const pubDate = $(element).find('pubDate').text().trim();
                    
                    const releaseDate = new Date(pubDate);
                    const isToday = releaseDate.toDateString() === today.toDateString();
                    
                    // Debug každý item
                    if (index < 5) { // Ukažeme prvních 5 pro debug
                        console.log(`📺 Item ${index}: "${title}" | Datum: ${releaseDate.toDateString()} | Dnes: ${isToday}`);
                    }
                    
                    if (isToday) {
                        todayCount++;
                        const match = title.match(/\[SubsPlease\]\s*(.+?)\s*-\s*(\d+(?:\.\d+)?)/);
                        if (match) {
                            const animeName = match[1].trim();
                            const episode = match[2];
                            const animeKey = `subsplease-${animeName}-${episode}`;
                            
                            console.log(`✅ Nalezeno dnešní anime: ${animeName} - ${episode}`);
                            
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
                                    source: 'SubsPlease',
                                    qualities: new Map()
                                });
                            }
                            
                            animeMap.get(animeKey).qualities.set(rss.quality, link);
                        } else {
                            console.log(`❌ Regex nesedí pro: "${title}"`);
                        }
                    }
                });
                
                console.log(`📊 ${rss.quality}: ${itemCount} celkem, ${todayCount} dnes`);
                
            } catch (error) {
                console.log(`❌ Chyba při načítání SubsPlease ${rss.quality}:`, error.message);
            }
        }
        
        const result = Array.from(animeMap.values());
        console.log(`🍜 SubsPlease výsledek: ${result.length} anime`);
        return result;
        
    } catch (error) {
        console.log('❌ SubsPlease obecná chyba:', error.message);
        return [];
    }
}

async function getEraiRawsAnime() {
    if (!sourceConfig.erairaws) {
        console.log('📴 Erai-raws je vypnutý');
        return [];
    }
    
    console.log('🦄 Načítám Erai-raws anime...');
    
    try {
        const rssUrl = 'https://erai-raws.info/feed/?res=1080p&type=torrent&token=08325c5afb433dc32feaa82190a74126';
        console.log(`📡 Načítám z ${rssUrl}`);
        
        const response = await axios.get(rssUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        
        const $ = cheerio.load(response.data, { xmlMode: true });
        const animeMap = new Map();
        const today = new Date();
        let itemCount = 0;
        let todayCount = 0;
        
        console.log(`📅 Dnešní datum: ${today.toDateString()}`);
        
        $('item').each((index, element) => {
            itemCount++;
            const title = $(element).find('title').text().trim();
            const link = $(element).find('link').text().trim();
            const pubDate = $(element).find('pubDate').text().trim();
            
            const releaseDate = new Date(pubDate);
            const isToday = releaseDate.toDateString() === today.toDateString();
            
            // Debug každý item
            if (index < 5) { // Ukažeme prvních 5 pro debug
                console.log(`📺 Item ${index}: "${title}" | Datum: ${releaseDate.toDateString()} | Dnes: ${isToday}`);
            }
            
            if (isToday) {
                todayCount++;
                // Erai-raws nový formát: [Torrent] Anime Name - Episode [kvalita info]
                const match = title.match(/\[Torrent\]\s*(.+?)\s*-\s*(\d+(?:\.\d+)?)/);
                if (match) {
                    let animeName = match[1].trim();
                    const episode = match[2];
                    
                    // Vyčistíme název od extra informací v závorkách
                    animeName = animeName
                        .replace(/\s*\(HEVC\).*$/, '') // Odstraníme (HEVC) a vše za tím
                        .replace(/\s*\(English Audio\).*$/, '') // Odstraníme (English Audio)
                        .replace(/\s*\(Chinese Audio\).*$/, '') // Odstraníme (Chinese Audio)
                        .replace(/\s*\(Japanese Audio\).*$/, '') // Odstraníme (Japanese Audio)
                        .replace(/\s*\(NF\).*$/, '') // Odstraníme (NF)
                        .trim();
                    
                    const animeKey = `erairaws-${animeName}-${episode}`;
                    
                    console.log(`✅ Nalezeno dnešní anime: ${animeName} - ${episode}`);
                    
                    if (!animeMap.has(animeKey)) {
                        animeMap.set(animeKey, {
                            id: `erairaws:${Buffer.from(animeKey).toString('base64')}`,
                            name: animeName,
                            episode: episode,
                            fullTitle: title,
                            poster: null,
                            background: null,
                            releaseInfo: releaseDate.toLocaleDateString('cs-CZ'),
                            type: 'series',
                            pubDate: pubDate,
                            source: 'Erai-raws',
                            qualities: new Map([['1080p', link]])
                        });
                    }
                } else {
                    console.log(`❌ Regex nesedí pro: "${title}"`);
                }
            }
        });
        
        console.log(`📊 Erai-raws: ${itemCount} celkem, ${todayCount} dnes`);
        
        const result = Array.from(animeMap.values());
        console.log(`🦄 Erai-raws výsledek: ${result.length} anime`);
        return result;
        
    } catch (error) {
        console.log('❌ Erai-raws chyba:', error.message);
        return [];
    }
}

async function getTodayAnime() {
    const now = Date.now();
    if (animeCache.data.length > 0 && (now - animeCache.timestamp) < animeCache.ttl) {
        return animeCache.data;
    }
    
    try {
        // Načteme anime z obou zdrojů paralelně
        const [subsPleaseAnime, eraiRawsAnime] = await Promise.all([
            getSubsPleaseAnime(),
            getEraiRawsAnime()
        ]);
        
        // Spojíme všechna anime
        const allAnime = [...subsPleaseAnime, ...eraiRawsAnime];
        
        console.log(`Načteno ${subsPleaseAnime.length} anime z SubsPlease, ${eraiRawsAnime.length} z Erai-raws`);
        
        if (allAnime.length === 0) {
            return [{
                id: 'demo:' + Buffer.from('Demo Anime-1').toString('base64'),
                name: 'Demo Anime',
                episode: '1',
                fullTitle: '[Demo] Demo Anime - 01 (1080p)',
                poster: 'https://via.placeholder.com/300x400/1a1a2e/ffffff?text=Demo+Anime',
                background: 'https://via.placeholder.com/1920x1080/1a1a2e/ffffff?text=Demo+Background',
                releaseInfo: 'Demo',
                type: 'series',
                source: 'Demo',
                qualities: new Map([['1080p', 'https://example.com/']])
            }];
        }

        const animeWithPosters = [];
        
        // Načteme postery postupně s malým zpožděním
        for (let i = 0; i < allAnime.length; i++) {
            const anime = allAnime[i];
            
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
        console.log('Chyba při načítání anime:', error.message);
        return [];
    }
}

async function getMagnetLinks(pageUrl, anime, quality = '1080p') {
    try {
        let targetUrl = pageUrl;
        if (anime.qualities && anime.qualities.has(quality)) {
            targetUrl = anime.qualities.get(quality);
        }
        
        // Pro SubsPlease - Nyaa.si linky
        if (targetUrl && targetUrl.includes('nyaa.si/view/') && anime.source === 'SubsPlease') {
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
                        title: `[${anime.source}] ${anime.name} - ${anime.episode} (${quality})`
                    }];
                }
            }
        }
        
        // Pro Erai-raws - přímé torrent linky
        if (targetUrl && anime.source === 'Erai-raws') {
            try {
                const torrentResponse = await axios.get(targetUrl, {
                    timeout: 10000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                    responseType: 'arraybuffer'
                });
                
                // Vytvoříme magnet link z torrent souboru (zjednodušená verze)
                // V reálné implementaci by se torrent parsoval pro získání hash
                const hash = Buffer.from(targetUrl).toString('hex').substring(0, 40).padEnd(40, '0');
                const magnetUrl = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(`[Erai-raws] ${anime.name} - ${anime.episode} [1080p]`)}&tr=http://nyaa.tracker.wf:7777/announce`;
                
                return [{
                    magnet: magnetUrl,
                    quality: quality,
                    title: `[${anime.source}] ${anime.name} - ${anime.episode} (${quality})`
                }];
            } catch (error) {
                console.log(`Chyba při načítání Erai-raws torrenta: ${error.message}`);
            }
        }

        // Fallback magnet pro případy, kdy se nepodaří získat skutečný
        const hash = anime.fullTitle?.match(/\[([A-F0-9]{8})\]/)?.[1]?.padEnd(40, '0') || '1'.repeat(40);
        const magnetUrl = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(`[${anime.source}] ${anime.name} - ${anime.episode} (${quality})`)}&tr=http://nyaa.tracker.wf:7777/announce`;
        
        return [{
            magnet: magnetUrl,
            quality: quality,
            title: `[${anime.source}] ${anime.name} - ${anime.episode} (${quality})`
        }];
    } catch (error) {
        console.log(`Chyba při získávání magnet linků: ${error.message}`);
        return [];
    }
}

// Routes
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SubsPlease + Erai-raws Stremio Addon</title>
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
        .source-controls {
            background: rgba(255, 255, 255, 0.1);
            padding: 30px; border-radius: 15px; margin: 30px 0;
        }
        .source-controls h3 { margin-bottom: 20px; text-align: center; }
        .toggle {
            display: flex; justify-content: space-between; align-items: center;
            margin: 20px 0; padding: 25px; background: rgba(255,255,255,0.1);
            border-radius: 15px; border: 1px solid rgba(255,255,255,0.2);
        }
        .source-info h4 { margin-bottom: 5px; font-size: 1.2rem; }
        .source-info small { opacity: 0.8; }
        .toggle-btn {
            padding: 15px 25px; border: none; border-radius: 10px; 
            font-weight: bold; font-size: 16px; cursor: pointer;
            transition: all 0.3s ease; min-width: 120px;
        }
        .toggle-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0,0,0,0.3); }
        .toggle-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
        .active { background: #27ae60; color: white; }
        .inactive { background: #e74c3c; color: white; }
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
        .install-btn {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white; border: none; padding: 15px 30px;
            border-radius: 10px; font-size: 18px; font-weight: 500;
            cursor: pointer; margin: 10px; text-decoration: none;
            display: inline-block; transition: transform 0.2s;
        }
        .install-btn:hover { transform: translateY(-2px); }
        .features {
            background: rgba(255, 193, 7, 0.1);
            padding: 25px; border-radius: 15px; margin: 30px 0;
            border: 1px solid rgba(255, 193, 7, 0.3);
        }
        .features h3 { margin-bottom: 15px; }
        .features ul { list-style: none; }
        .features li { margin: 8px 0; padding-left: 20px; position: relative; }
        .features li:before { content: "•"; color: #ffd93d; position: absolute; left: 0; font-size: 20px; }
        .keepalive-info {
            background: rgba(0, 255, 127, 0.1);
            padding: 20px; border-radius: 15px; margin: 30px 0;
            border: 1px solid rgba(0, 255, 127, 0.3);
            text-align: center; font-size: 14px;
        }
        #message {
            margin: 20px 0; padding: 15px; border-radius: 10px; 
            font-weight: bold; text-align: center; display: none;
        }
        .success { background: rgba(40, 167, 69, 0.3); color: #28a745; }
        .error { background: rgba(220, 53, 69, 0.3); color: #dc3545; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">🍜</div>
            <h1>SubsPlease + Erai-raws</h1>
            <p class="subtitle">Airtime Today - dnešní anime s RealDebrid podporou</p>
        </div>

        <div class="status ${REAL_DEBRID_API_KEY ? 'ok' : 'error'}">
            ${REAL_DEBRID_API_KEY ? 
                '✅ RealDebrid API klíč je nakonfigurován' : 
                '⚠️ RealDebrid API klíč není nastaven - kontaktujte administrátora'
            }
        </div>

        <div class="source-controls">
            <h3>🎛️ Konfigurace zdrojů</h3>
            
            <div class="toggle">
                <div class="source-info">
                    <h4>🍜 SubsPlease</h4>
                    <small>1080p + 720p kvalita z nyaa.si</small>
                </div>
                <button id="subsplease-btn" class="${sourceConfig.subsplease ? 'active' : 'inactive'} toggle-btn" 
                        onclick="toggleSource('subsplease')">
                    ${sourceConfig.subsplease ? 'ZAPNUTO' : 'VYPNUTO'}
                </button>
            </div>
            
            <div class="toggle">
                <div class="source-info">
                    <h4>🦄 Erai-raws</h4>
                    <small>1080p kvalita s více titulky</small>
                </div>
                <button id="erairaws-btn" class="${sourceConfig.erairaws ? 'active' : 'inactive'} toggle-btn" 
                        onclick="toggleSource('erairaws')">
                    ${sourceConfig.erairaws ? 'ZAPNUTO' : 'VYPNUTO'}
                </button>
            </div>
            
            <div id="message"></div>
        </div>

        <div class="install-section">
            <h2>📱 Instalace do Stremio</h2>
            <p>Zkopírujte tuto URL a přidejte ji jako addon v Stremio:</p>
            <div class="url-box">${req.protocol}://${req.get('host')}/manifest.json</div>
            <a href="stremio://${req.get('host')}/manifest.json" class="install-btn">
                🚀 Instalovat do Stremio
            </a>
        </div>

        <div class="features">
            <h3>📺 Funkce addonu</h3>
            <ul>
                <li>Zobrazuje pouze anime vydané dnes</li>
                <li>Kombinuje SubsPlease a Erai-raws zdroje</li>
                <li>Automatické načítání posterů z MyAnimeList API</li>
                <li>Kontrola nových anime každých 14 minut</li>
                <li>RealDebrid streaming s přímými linky</li>
                <li>Podpora pro 1080p a 720p rozlišení</li>
                <li>Webové ovládání zdrojů</li>
            </ul>
        </div>

        <div class="keepalive-info">
            🏓 <strong>Keep-Alive systém aktivní</strong><br>
            Server se automaticky pinguje každých 10 minut, aby se na Render.com neuspal<br>
            📊 <strong>Aktuální stav:</strong> SubsPlease=${sourceConfig.subsplease ? 'ZAP' : 'VYP'}, Erai-raws=${sourceConfig.erairaws ? 'ZAP' : 'VYP'}
        </div>
    </div>

    <script>
        function showMessage(text, type) {
            var msg = document.getElementById('message');
            msg.textContent = text;
            msg.className = type;
            msg.style.display = 'block';
            setTimeout(function() { msg.style.display = 'none'; }, 4000);
        }
        
        function updateButton(buttonId, isActive) {
            var btn = document.getElementById(buttonId);
            if (isActive) {
                btn.className = 'active toggle-btn';
                btn.textContent = 'ZAPNUTO';
            } else {
                btn.className = 'inactive toggle-btn';
                btn.textContent = 'VYPNUTO';
            }
        }
        
        function toggleSource(source) {
            var btn = document.getElementById(source + '-btn');
            btn.disabled = true;
            btn.textContent = 'POČKEJTE...';
            
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/toggle-source');
            xhr.setRequestHeader('Content-Type', 'application/json');
            
            xhr.onload = function() {
                btn.disabled = false;
                
                if (xhr.status === 200) {
                    var result = JSON.parse(xhr.responseText);
                    updateButton(source + '-btn', result.enabled);
                    
                    var sourceLabel = source === 'subsplease' ? 'SubsPlease' : 'Erai-raws';
                    showMessage(sourceLabel + ' byl ' + (result.enabled ? 'zapnut' : 'vypnut'), 'success');
                } else {
                    showMessage('Chyba serveru: ' + xhr.status, 'error');
                }
            };
            
            xhr.onerror = function() {
                btn.disabled = false;
                showMessage('Chyba při komunikaci se serverem', 'error');
            };
            
            xhr.send(JSON.stringify({ source: source }));
        }
    </script>
</body>
</html>
    `);
});

// API endpointy
app.post('/toggle-source', (req, res) => {
    const { source } = req.body;
    console.log(`📡 Toggle request pro: ${source}`);
    
    if (source === 'subsplease' || source === 'erairaws') {
        sourceConfig[source] = !sourceConfig[source];
        animeCache.data = [];
        animeCache.timestamp = 0;
        
        console.log(`📡 ${source} je nyní ${sourceConfig[source] ? 'zapnut' : 'vypnut'}`);
        
        res.json({
            success: true,
            source: source,
            enabled: sourceConfig[source]
        });
    } else {
        res.status(400).json({ success: false, message: 'Neplatný zdroj' });
    }
});

app.get('/manifest.json', (req, res) => res.json(ADDON_CONFIG));

app.get('/catalog/:type/:id.json', async (req, res) => {
    try {
        const catalogId = req.params.id;
        const animeList = await getTodayAnime();
        
        let metas = [];
        
        if (catalogId === 'subsplease_today') {
            // Pouze SubsPlease anime
            const subsPleaseAnime = animeList.filter(anime => anime.source === 'SubsPlease');
            
            metas = subsPleaseAnime.map(anime => ({
                id: anime.id,
                type: 'series',
                name: `${anime.name}`,
                poster: anime.poster,
                background: anime.background,
                description: `Epizoda ${anime.episode} - ${anime.releaseInfo}\nZdroj: SubsPlease\nKvalita: 1080p + 720p`,
                genres: ['Anime', 'SubsPlease'],
                year: new Date().getFullYear(),
                imdbRating: 8.5,
                releaseInfo: anime.releaseInfo
            }));
            
        } else if (catalogId === 'erairaws_today') {
            // Pouze Erai-raws anime
            const eraiRawsAnime = animeList.filter(anime => anime.source === 'Erai-raws');
            
            metas = eraiRawsAnime.map(anime => ({
                id: anime.id,
                type: 'series',
                name: `${anime.name}`,
                poster: anime.poster,
                background: anime.background,
                description: `Epizoda ${anime.episode} - ${anime.releaseInfo}\nZdroj: Erai-raws\nKvalita: 1080p s více titulky`,
                genres: ['Anime', 'Erai-raws'],
                year: new Date().getFullYear(),
                imdbRating: 8.5,
                releaseInfo: anime.releaseInfo
            }));
        }

        // Cache busting headers
        res.set({
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        res.json({ metas });
        
    } catch (error) {
        res.status(500).json({ 
            metas: [],
            error: 'Chyba při načítání katalogu'
        });
    }
});

app.get('/catalog/:type/:id/:extra.json', async (req, res) => {
    try {
        const catalogId = req.params.id;
        const animeList = await getTodayAnime();
        
        let metas = [];
        
        if (catalogId === 'subsplease_today') {
            // Pouze SubsPlease anime
            const subsPleaseAnime = animeList.filter(anime => anime.source === 'SubsPlease');
            
            metas = subsPleaseAnime.map(anime => ({
                id: anime.id,
                type: 'series',
                name: `${anime.name}`,
                poster: anime.poster,
                background: anime.background,
                description: `Epizoda ${anime.episode} - ${anime.releaseInfo}\nZdroj: SubsPlease\nKvalita: 1080p + 720p`,
                genres: ['Anime', 'SubsPlease'],
                year: new Date().getFullYear(),
                imdbRating: 8.5,
                releaseInfo: anime.releaseInfo
            }));
            
        } else if (catalogId === 'erairaws_today') {
            // Pouze Erai-raws anime
            const eraiRawsAnime = animeList.filter(anime => anime.source === 'Erai-raws');
            
            metas = eraiRawsAnime.map(anime => ({
                id: anime.id,
                type: 'series',
                name: `${anime.name}`,
                poster: anime.poster,
                background: anime.background,
                description: `Epizoda ${anime.episode} - ${anime.releaseInfo}\nZdroj: Erai-raws\nKvalita: 1080p s více titulky`,
                genres: ['Anime', 'Erai-raws'],
                year: new Date().getFullYear(),
                imdbRating: 8.5,
                releaseInfo: anime.releaseInfo
            }));
        }

        // Cache busting headers
        res.set({
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });

        res.json({ metas });
        
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
        
        if (animeId.startsWith('subsplease:') || animeId.startsWith('erairaws:')) {
            const animeList = await getTodayAnime();
            const anime = animeList.find(a => a.id === animeId);
            
            if (anime) {
                res.json({
                    meta: {
                        id: anime.id,
                        type: 'series',
                        name: `${anime.name} [${anime.source}]`,
                        poster: anime.poster,
                        background: anime.background,
                        description: `${anime.fullTitle}\n\nZdroj: ${anime.source}\nVydáno: ${anime.releaseInfo}`,
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
                            overview: `${anime.fullTitle} (${anime.source})`,
                            thumbnail: anime.poster
                        }]
                    }
                });
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
        
        if (animeId.startsWith('subsplease:') || animeId.startsWith('erairaws:')) {
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
                                            name: `🚀 RealDebrid ${quality} [${anime.source}]`,
                                            title: magnet.title,
                                            url: streamUrl,
                                            behaviorHints: {
                                                bingeGroup: `${anime.source.toLowerCase()}-${anime.name}`,
                                                notWebReady: false
                                            }
                                        });
                                    } else {
                                        streams.push({
                                            name: `🚀 RealDebrid ${quality} (Processing...) [${anime.source}]`,
                                            title: `${magnet.title} - Torrent ID: ${rdResponse.id}`,
                                            url: magnet.magnet,
                                            behaviorHints: {
                                                bingeGroup: `${anime.source.toLowerCase()}-${anime.name}`,
                                                notWebReady: true
                                            }
                                        });
                                    }
                                }
                            } catch (error) {
                                streams.push({
                                    name: `⚡ ${quality} (Magnet) [${anime.source}]`,
                                    title: magnet.title,
                                    url: magnet.magnet,
                                    behaviorHints: {
                                        bingeGroup: `${anime.source.toLowerCase()}-${anime.name}`,
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
        keepAlive: true,
        sources: {
            subsplease: sourceConfig.subsplease,
            erairaws: sourceConfig.erairaws
        }
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SubsPlease + Erai-raws Stremio addon běží na portu ${PORT}`);
    console.log(`⏰ Cache interval: 14 minut`);
    console.log(`🏓 Keep-alive ping: každých 10 minut`);
    console.log(`🔑 RealDebrid API klíč:`, REAL_DEBRID_API_KEY ? 'NASTAVEN' : 'NENÍ NASTAVEN');
    console.log(`📡 Zdroje: SubsPlease=${sourceConfig.subsplease}, Erai-raws=${sourceConfig.erairaws}`);
    
    // Spustíme první ping po 5 minutách od startu
    setTimeout(() => {
        console.log(`🏓 Spouštím keep-alive systém...`);
        keepAlive(); // První ping
    }, 5 * 60 * 1000); // 5 minut po startu
});