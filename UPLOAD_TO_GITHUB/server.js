import express from 'express';
import cors from 'cors';
import https from 'https';
import { scrapeLegal } from './src/services/legalScraper.js';

// Simple in-memory cache: { [key]: { data, expiresAt } }
const psCache = new Map();
const PS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Prune the massive Lighthouse response to only what the UI needs (<10 KB)
function prunePageSpeedData(raw) {
    try {
        const le = raw.loadingExperience || raw.originLoadingExperience || {};
        const ole = raw.originLoadingExperience || {};
        return {
            id: raw.id,
            loadingExperience: {
                overall_category: le.overall_category,
                metrics: le.metrics
            },
            originLoadingExperience: {
                overall_category: ole.overall_category,
                metrics: ole.metrics
            },
            lighthouseResult: {
                lighthouseVersion: raw.lighthouseResult?.lighthouseVersion,
                categories: {
                    performance: {
                        score: raw.lighthouseResult?.categories?.performance?.score
                    }
                }
            }
        };
    } catch (e) {
        return raw; // fallback: return whole thing if pruning fails
    }
}

// Fetch one PageSpeed strategy with a hard timeout
// fields= limits response to only what the UI needs (skips full Lighthouse audit JSON)
function fetchPageSpeed(domain, strategy, timeoutMs = 58000) {
    return new Promise((resolve, reject) => {
        const apiKey = 'AIzaSyAwLB1oZ9dO36LsDzWdBiknSRtLmYOAoCw';
        const fields = encodeURIComponent(
            'loadingExperience,originLoadingExperience,lighthouseResult.categories.performance.score,lighthouseResult.lighthouseVersion'
        );
        const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${domain}/&key=${apiKey}&category=performance&strategy=${strategy}&fields=${fields}`;
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; reject(new Error(`Timeout after ${timeoutMs}ms`)); }
        }, timeoutMs);
        https.get(url, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                clearTimeout(timer);
                if (settled) return;
                settled = true;
                try {
                    const json = JSON.parse(body);
                    if (json.error) return reject(new Error(json.error.message || 'API error'));
                    resolve(json);
                } catch (e) { reject(e); }
            });
            res.on('error', e => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } });
        }).on('error', e => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } });
    });
}

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.get('/scrape', async (req, res) => {
    const { domain } = req.query;

    if (!domain) {
        return res.status(400).json({ error: 'Domain is required' });
    }

    console.log(`Received scraping request for: ${domain}`);

    try {
        const result = await scrapeLegal(domain);
        if (result) {
            console.log(`✓ Scraped successfully: ${result.name || 'No Name'} (${result.googlePublisherId || 'No ID'})`);
            result.domain = domain; // Add domain to response as requested
            return res.json(result);
        } else {
            console.log(`✗ No data found for ${domain}`);
            return res.json(null); // Return null if nothing found, but 200 OK
        }
    } catch (error) {
        console.error(`Error scraping ${domain}:`, error);
        return res.status(500).json({ error: 'Failed to scrape domain' });
    }
});

// PageSpeed Proxy - returns pruned data, uses cache, never crashes the server
app.get('/pagespeed', async (req, res) => {
    const { domain, strategy, refresh } = req.query;
    if (!domain || !strategy) {
        return res.status(400).json({ error: 'domain and strategy are required' });
    }
    const cacheKey = `${domain}:${strategy}`;
    const cached = psCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() && refresh !== 'true') {
        console.log(`[PSI] Cache hit: ${cacheKey}`);
        return res.json(cached.data);
    }

    console.log(`[PSI] Fetching ${strategy} for ${domain}...`);
    try {
        let raw;
        try {
            raw = await fetchPageSpeed(domain, strategy);
        } catch (firstErr) {
            console.warn(`[PSI] Direct failed for ${domain}, checking root fallback...`);
            const parts = domain.split('.');
            if (parts.length > 2) {
                const root = parts.slice(-2).join('.');
                raw = await fetchPageSpeed(root, strategy);
                console.log(`[PSI] Success via root: ${root}`);
            } else {
                throw firstErr;
            }
        }

        const pruned = prunePageSpeedData(raw);
        psCache.set(cacheKey, { data: pruned, expiresAt: Date.now() + PS_CACHE_TTL_MS });
        return res.json(pruned);
    } catch (err) {
        console.error(`[PSI] Final failure (${strategy}/${domain}): ${err.message}`);
        // Return a structured error so frontend knows it's a null result rather than a hard crash
        return res.status(200).json({ error: err.message, data: null });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Proxying requests to bypass CORS...`);
});
