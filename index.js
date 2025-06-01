const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

async function addMagnetToRealDebrid(magnetUrl, apiKey) {
    const response = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
        `magnet=${encodeURIComponent(magnetUrl)}`,
        {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );
    return response.data;
}

async function getRealDebridStreamUrl(torrentId, apiKey, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const torrentInfo = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${torrentId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });

            if (torrentInfo.data.status === 'downloaded' && torrentInfo.data.links && torrentInfo.data.links.length > 0) {
                const downloadLink = torrentInfo.data.links[0];
                
                const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link',
                    `link=${encodeURIComponent(downloadLink)}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/x-www-form-urlencoded'
                        }
                    }
                );
                
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
        cacheSize: animeCache.data.length,
        cacheAge: Date.now() - animeCache.timestamp
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SubsPlease Stremio addon běží na portu ${PORT}`);
    console.log(`⏰ Cache interval: 14 minut`);
    console.log(`🌍 Veřejně dostupný addon s osobními API klíči`);
});unrestrict.data && unrestrict.data.download) {
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
                                'Authorization': `Bearer ${apiKey}`,
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
        const specialMappings = {
            'Kimi to Idol Precure': 'Wonderful Precure',
            'Kimi to Idol PreCure': 'Wonderful Precure',
            'Pretty Cure': 'Precure',
            'PreCure': 'Precure',
            'Shirohiyo': 'Shiro Hiyoko'
        };
        
        let searchName = specialMappings[animeName] || animeName;
        
        searchName = searchName
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        
        const searchQuery = encodeURIComponent(searchName);
        const searchUrl = `https://api.jikan.moe/v4/anime?q=${searchQuery}&limit=3`;
        
        let attempt = 0;
        const maxAttempts = 3;
        
        while (attempt < maxAttempts) {
            try {
                if (attempt > 0) {
                    const delay = Math.random() * 2000 + 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                
                const response = await axios.get(searchUrl, { 
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'SubsPlease-Stremio-Addon/1.0'
                    }
                });
                
                if (response.data && response.data.data && response.data.data.length > 0) {
                    let bestMatch = response.data.data[0];
                    
                    if (response.data.data.length > 1) {
                        for (const anime of response.data.data) {
                            const title = anime.title?.toLowerCase() || '';
                            const searchLower = searchName.toLowerCase();
                            
                            if (title.includes(searchLower) || searchLower.includes(title)) {
                                bestMatch = anime;
                                break;
                            }
                        }
                    }
                    
                    const images = bestMatch.images?.jpg;
                    const posterUrl = images?.large_image_url || images?.image_url;
                    
                    if (posterUrl) {
                        return {
                            poster: posterUrl,
                            background: posterUrl
                        };
                    }
                }
                
                break;
                
            } catch (error) {
                attempt++;
                
                if (error.response?.status === 429) {
                    if (attempt >= maxAttempts) break;
                    continue;
                } else {
                    break;
                }
            }
        }
    } catch (error) {
        // Fallback
    }
    
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
                                    qualities: new Map()
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
        
        const animeList = Array.from(animeMap.values());

        const animeWithPosters = [];
        
        for (let i = 0; i < animeList.length; i++) {
            const anime = animeList[i];
            
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
        return [{
            id: 'subsplease:' + Buffer.from('Demo Anime-1').toString('base64'),
            name: 'Demo Anime',
            episode: '1',
            fullTitle: '[SubsPlease] Demo Anime - 01 (1080p)',
            poster: 'https://via.placeholder.com/300x400/1a1a2e/ffffff?text=Demo+Anime',
            background: 'https://via.placeholder.com/1920x1080/1a1a2e/ffffff?text=Demo+Background',
            releaseInfo: 'Demo',
            type: 'series',
            link: 'https://subsplease.org/',
            qualities: new Map([['1080p', 'https://subsplease.org/'], ['720p', 'https://subsplease.org/']])
        }];
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
            max-width: 900px; margin: 0 auto;
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
        .section {
            background: rgba(255, 255, 255, 0.1);
            padding: 30px; border-radius: 15px; margin: 30px 0;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .form-group { margin: 20px 0; }
        .form-group label {
            display: block; margin-bottom: 8px;
            font-weight: 500; color: white;
        }
        .form-group input {
            width: 100%; padding: 12px 16px;
            border: 2px solid rgba(255,255,255,0.3); 
            border-radius: 10px; font-size: 16px;
            background: rgba(255,255,255,0.1);
            color: white;
        }
        .form-group input::placeholder {
            color: rgba(255,255,255,0.7);
        }
        .btn {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white; border: none; padding: 12px 24px;
            border-radius: 10px; font-size: 16px; font-weight: 500;
            cursor: pointer; margin: 10px 5px; text-decoration: none;
            display: inline-block; transition: transform 0.2s;
        }
        .btn:hover { transform: translateY(-2px); }
        .btn-success { background: linear-gradient(45deg, #28a745, #20c997); }
        .btn-install { background: linear-gradient(45deg, #ff6b6b, #ffd93d); font-size: 18px; padding: 15px 30px; }
        .url-box {
            background: rgba(0,0,0,0.3); padding: 15px; 
            border-radius: 8px; margin: 15px 0;
            word-break: break-all; font-family: monospace;
            border: 1px solid rgba(255,255,255,0.2);
            font-size: 14px;
        }
        .alert {
            padding: 15px; margin: 15px 0; border-radius: 8px;
            border: 1px solid;
        }
        .alert-success { 
            background: rgba(40, 167, 69, 0.2); 
            border-color: #28a745; 
            color: #d4edda; 
        }
        .alert-danger { 
            background: rgba(220, 53, 69, 0.2); 
            border-color: #dc3545; 
            color: #f8d7da; 
        }
        .alert-info { 
            background: rgba(23, 162, 184, 0.2); 
            border-color: #17a2b8; 
            color: #d1ecf1; 
        }
        .features {
            background: rgba(255, 193, 7, 0.1);
            padding: 20px; border-radius: 10px; margin: 20px 0;
            border: 1px solid rgba(255, 193, 7, 0.3);
        }
        .install-section {
            text-align: center;
            padding: 20px 0;
        }
        .step {
            margin: 15px 0;
            padding: 15px;
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            text-align: left;
        }
        .step-number {
            display: inline-block;
            width: 30px; height: 30px;
            background: linear-gradient(45deg, #ff6b6b, #ffd93d);
            border-radius: 50%;
            text-align: center;
            line-height: 30px;
            font-weight: bold;
            margin-right: 10px;
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

        <div class="section">
            <h2>🔑 Váš RealDebrid API Klíč</h2>
            <p style="margin-bottom: 20px;">Pro použití addonu potřebujete RealDebrid Premium účet a API klíč.</p>
            
            <div class="step">
                <span class="step-number">1</span>
                <strong>Získejte API klíč:</strong> Jděte na 
                <a href="https://real-debrid.com/apitoken" target="_blank" style="color: #ffd93d;">real-debrid.com/apitoken</a>
            </div>
            
            <div class="step">
                <span class="step-number">2</span>
                <strong>Vložte API klíč zde:</strong>
                <div class="form-group">
                    <input type="password" id="apiKey" placeholder="Vložte váš RealDebrid API token zde">
                </div>
            </div>
            
            <div class="step">
                <span class="step-number">3</span>
                <strong>Ověřte klíč a získejte osobní URL:</strong>
                <button class="btn btn-success" onclick="generatePersonalUrl()">🔗 Vygenerovat osobní URL</button>
            </div>
            
            <div id="apiStatus"></div>
            <div id="personalUrl" style="display: none;">
                <h3 style="margin: 20px 0 10px 0;">📱 Vaše osobní URL pro Stremio:</h3>
                <div class="url-box" id="manifestUrl"></div>
                <div class="install-section">
                    <button class="btn btn-install" onclick="installToStremio()">🚀 Instalovat do Stremio</button>
                    <p style="margin-top: 15px; opacity: 0.8; font-size: 14px;">
                        Tato URL obsahuje váš API klíč a je pouze pro vás!
                    </p>
                </div>
            </div>
        </div>

        <div class="features">
            <strong>📺 Funkce addonu:</strong><br>
            • Zobrazuje pouze anime vydané DNES<br>
            • Automatické načítání posterů z MyAnimeList API<br>
            • Kontrola nových anime každých 14 minut<br>
            • RealDebrid streaming s direct links<br>
            • Podpora pro 1080p a 720p rozlišení<br>
            • Každý uživatel má svou vlastní konfiguraci
        </div>
    </div>

    <script>
        function generatePersonalUrl() {
            const apiKey = document.getElementById('apiKey').value;
            const statusDiv = document.getElementById('apiStatus');
            
            if (!apiKey) {
                statusDiv.innerHTML = '<div class="alert alert-danger">⚠️ Vložte prosím API klíč</div>';
                return;
            }
            
            statusDiv.innerHTML = '<div class="alert alert-info">🔄 Ověřuji API klíč...</div>';
            
            // Ověříme API klíč
            fetch('https://api.real-debrid.com/rest/1.0/user', {
                headers: { 'Authorization': 'Bearer ' + apiKey }
            })
            .then(res => {
                if (!res.ok) throw new Error('Neplatný API klíč');
                return res.json();
            })
            .then(data => {
                statusDiv.innerHTML = '<div class="alert alert-success">✅ API klíč ověřen! Uživatel: ' + data.username + '</div>';
                
                // Vygenerujeme osobní URL
                const personalManifestUrl = window.location.origin + '/manifest/' + btoa(apiKey) + '.json';
                document.getElementById('manifestUrl').textContent = personalManifestUrl;
                document.getElementById('personalUrl').style.display = 'block';
                
                // Uložíme do URL
                window.generatedManifestUrl = personalManifestUrl;
            })
            .catch(err => {
                statusDiv.innerHTML = '<div class="alert alert-danger">❌ ' + err.message + '</div>';
            });
        }

        function installToStremio() {
            if (window.generatedManifestUrl) {
                const stremioUrl = 'stremio://' + window.generatedManifestUrl.replace('https://', '').replace('http://', '');
                window.open(stremioUrl, '_blank');
            }
        }

        // Auto-focus na input
        document.getElementById('apiKey').focus();
    </script>
</body>
</html>`);
});

app.get('/manifest/:encodedApiKey.json', (req, res) => {
    try {
        const apiKey = Buffer.from(req.params.encodedApiKey, 'base64').toString('utf-8');
        
        // Jednoduchá validace API klíče
        if (!apiKey || apiKey.length < 20) {
            return res.status(400).json({ error: 'Neplatný API klíč' });
        }
        
        res.json(ADDON_CONFIG);
    } catch (error) {
        res.status(400).json({ error: 'Chyba při dekódování API klíče' });
    }
});

app.get('/catalog/:type/:id/:encodedApiKey.json', async (req, res) => {
    try {
        if (req.params.id === 'subsplease_today') {
            const animeList = await getTodayAnime();
            
            const metas = animeList.map(anime => ({
                id: anime.id + ':' + req.params.encodedApiKey,
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

app.get('/meta/:type/:id/:encodedApiKey.json', async (req, res) => {
    try {
        const fullId = req.params.id;
        const encodedApiKey = req.params.encodedApiKey;
        const animeId = fullId.replace(':' + encodedApiKey, '');
        
        if (animeId.startsWith('subsplease:')) {
            const animeList = await getTodayAnime();
            const anime = animeList.find(a => a.id === animeId);
            
            if (anime) {
                res.json({
                    meta: {
                        id: anime.id + ':' + encodedApiKey,
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
                            id: `${anime.id}:1:${anime.episode}:${encodedApiKey}`,
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
                res.status(404).json({ error: 'Anime nenalezeno' });
            }
        } else {
            res.status(404).json({ error: 'Neplatné ID' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Chyba serveru' });
    }
});

app.get('/stream/:type/:id/:encodedApiKey.json', async (req, res) => {
    try {
        const videoId = req.params.id;
        const encodedApiKey = req.params.encodedApiKey;
        const apiKey = Buffer.from(encodedApiKey, 'base64').toString('utf-8');
        
        const parts = videoId.split(':');
        const animeId = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : videoId.replace(':' + encodedApiKey, '');
        
        if (animeId.startsWith('subsplease:')) {
            const animeList = await getTodayAnime();
            const anime = animeList.find(a => a.id === animeId);
            
            if (anime) {
                const streams = [];
                
                if (!apiKey || apiKey.length < 20) {
                    streams.push({
                        name: '🔑 Neplatný API klíč',
                        title: 'Vraťte se na hlavní stránku a vygenerujte novou URL',
                        url: req.protocol + '://' + req.get('host')
                    });
                } else {
                    const availableQualities = anime.qualities ? Array.from(anime.qualities.keys()) : ['1080p'];
                    
                    for (const quality of availableQualities) {
                        const magnetLinks = await getMagnetLinks(null, anime, quality);
                        
                        for (const magnet of magnetLinks) {
                            try {
                                const rdResponse = await addMagnetToRealDebrid(magnet.magnet, apiKey);
                                if (rdResponse?.id) {
                                    const streamUrl = await getRealDebridStreamUrl(rdResponse.id, apiKey);
                                    
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

                if (