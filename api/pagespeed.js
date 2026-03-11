import https from 'https';

// Simple in-memory cache (resets on cold start, but still helps within a session)
const psCache = new Map();
const PS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function fetchPageSpeed(domain, strategy, timeoutMs = 58000) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.VITE_PAGESPEED_KEY || 'AIzaSyAwLB1oZ9dO36LsDzWdBiknSRtLmYOAoCw';
        const fields = encodeURIComponent(
            'loadingExperience,originLoadingExperience,lighthouseResult.categories.performance.score,lighthouseResult.lighthouseVersion'
        );
        const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${domain}/&key=${apiKey}&category=performance&strategy=${strategy}&fields=${fields}`;
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; reject(new Error(`Timeout after ${timeoutMs}ms`)); }
        }, timeoutMs);
        https.get(url, (response) => {
            let body = '';
            response.on('data', chunk => body += chunk);
            response.on('end', () => {
                clearTimeout(timer);
                if (settled) return;
                settled = true;
                try {
                    const json = JSON.parse(body);
                    if (json.error) return reject(new Error(json.error.message || 'API error'));
                    resolve(json);
                } catch (e) { reject(e); }
            });
            response.on('error', e => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } });
        }).on('error', e => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } });
    });
}

function prunePageSpeedData(raw) {
    try {
        const le = raw.loadingExperience || raw.originLoadingExperience || {};
        const ole = raw.originLoadingExperience || {};
        return {
            id: raw.id,
            loadingExperience: { overall_category: le.overall_category, metrics: le.metrics },
            originLoadingExperience: { overall_category: ole.overall_category, metrics: ole.metrics },
            lighthouseResult: {
                lighthouseVersion: raw.lighthouseResult?.lighthouseVersion,
                categories: { performance: { score: raw.lighthouseResult?.categories?.performance?.score } }
            }
        };
    } catch (e) {
        return raw;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { domain, strategy } = req.query;
    if (!domain || !strategy) {
        return res.status(400).json({ error: 'domain and strategy are required' });
    }

    const cacheKey = `${domain}:${strategy}`;
    const cached = psCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return res.json({ source: 'cache', data: cached.data });
    }

    try {
        const raw = await fetchPageSpeed(domain, strategy);
        const pruned = prunePageSpeedData(raw);
        psCache.set(cacheKey, { data: pruned, expiresAt: Date.now() + PS_CACHE_TTL_MS });
        return res.json({ source: 'live', data: pruned });
    } catch (err) {
        console.error(`[PSI] Error (${strategy}/${domain}): ${err.message}`);
        return res.status(502).json({ error: err.message || 'PageSpeed API failed' });
    }
}
