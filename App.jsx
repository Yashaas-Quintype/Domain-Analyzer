import React, { useState, useRef } from 'react';
import axios from 'axios';
import DecisionMakers from './components/DecisionMakers.jsx';
import BulkAnalyzer from './components/BulkAnalyzer.jsx';
import { searchDecisionMakers } from './services/lushaApi.js';
import { scrapeLegal } from './services/legalScraper.js';
import { withRetry } from './utils/apiRetry.js';

// Helper to filter and categorize tech stack
const processTech = (allTechnologies) => {
    if (!allTechnologies || allTechnologies.length === 0) return null;

    const threeMonthsInMs = 90 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const recentThreshold = now - threeMonthsInMs;

    return allTechnologies
        .filter(tech => tech.Name !== 'Content Delivery Network')
        .sort((a, b) => (b.LastDetected || 0) - (a.LastDetected || 0))
        .reduce((acc, tech) => {
            let category = tech.Tag || 'Other';
            const lowerCat = category.toLowerCase();
            if (['content delivery network', 'cdns', 'cdn'].includes(lowerCat)) category = 'CDN';
            if (!acc[category]) acc[category] = [];

            const isRecent = tech.LastDetected && tech.LastDetected >= recentThreshold;

            if (!acc[category].find(t => t.Name === tech.Name)) {
                acc[category].push({ ...tech, isRecent });
            }
            return acc;
        }, {});
};

const getDomainRoot = (hostname) => {
    if (!hostname) return '';
    const cleaned = hostname.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
    const parts = cleaned.split('.');
    if (parts.length <= 2) return cleaned;

    const multiPartTlds = ['co.uk', 'org.uk', 'me.uk', 'net.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in'];
    const lastTwo = parts.slice(-2).join('.');
    if (multiPartTlds.includes(lastTwo) && parts.length > 2) {
        return parts.slice(-3).join('.');
    }

    return parts.slice(-2).join('.');
};

function App() {
    const activeSearchDomain = useRef('');
    const [domain, setDomain] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [data, setData] = useState(null);
    const [techStack, setTechStack] = useState(null);
    const [cache] = useState({});
    const [showAllTech, setShowAllTech] = useState(false);
    const [showMonthlyVisits, setShowMonthlyVisits] = useState(false);
    const [activeTab, setActiveTab] = useState('single');

    // Lusha State
    const [lushaData, setLushaData] = useState(null);
    const [lushaLoading, setLushaLoading] = useState(false);
    const [lushaError, setLushaError] = useState(null);
    const [lushaRequested, setLushaRequested] = useState(false);

    // Scraper State
    const [scrapedCompany, setScrapedCompany] = useState(null);
    const [scrapedLoading, setScrapedLoading] = useState(false);
    const [redirectingParent, setRedirectingParent] = useState(null);
    const [retryingStatus, setRetryingStatus] = useState(null);
    const [pageSpeedMobile, setPageSpeedMobile] = useState(null);
    const [pageSpeedDesktop, setPageSpeedDesktop] = useState(null);
    const [pageSpeedLoading, setPageSpeedLoading] = useState(false);
    const [pageSpeedStarted, setPageSpeedStarted] = useState(false);
    const [trafficLoading, setTrafficLoading] = useState(false);
    const [techLoading, setTechLoading] = useState(false);
    const [copied, setCopied] = useState(false);

    // History State
    const [searchHistory, setSearchHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [isHistoryOpen, setIsHistoryOpen] = useState(false);

    // Helper to load a domain from history/cache
    const loadFromHistory = (index) => {
        if (index < 0 || index >= searchHistory.length) return;
        const targetDomain = searchHistory[index];
        const cached = cache[targetDomain.toLowerCase().trim()];

        if (cached) {
            setDomain(targetDomain);
            activeSearchDomain.current = targetDomain;
            setHistoryIndex(index);

            // Restore all state from cache
            setData(cached.traffic);
            setTechStack(cached.tech);
            setLushaData(cached.lusha);
            setScrapedCompany(cached.scraped);
            setPageSpeedMobile(cached.pageSpeed_mobile);
            setPageSpeedDesktop(cached.pageSpeed_desktop);

            // Reset loading states
            setLoading(false);
            setTrafficLoading(false);
            setTechLoading(false);
            setPageSpeedLoading(false);
            setPageSpeedStarted(true);
            setLushaLoading(false);
            setLushaRequested(!!cached.lusha);
        }
    };

    const addToHistory = (newDomain) => {
        const cleanDomain = newDomain.toLowerCase().trim();
        // Don't add if it's the same as the current history item
        if (historyIndex >= 0 && searchHistory[historyIndex].toLowerCase().trim() === cleanDomain) return;

        const newHistory = [...searchHistory.slice(0, historyIndex + 1), newDomain];
        setSearchHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);
    };

    const handleAnalyze = async (e) => {
        e.preventDefault();
        if (!domain) return;

        const cleanSearch = domain.toLowerCase().trim();
        if (cache[cleanSearch]) {
            console.log("Serving from cache:", cleanSearch);
            const cached = cache[cleanSearch];
            setData(cached.traffic);
            setTechStack(cached.tech);
            setLushaData(cached.lusha);
            setScrapedCompany(cached.scraped);
            setPageSpeedMobile(cached.pageSpeed_mobile);
            setPageSpeedDesktop(cached.pageSpeed_desktop);
            setLushaRequested(!!cached.lusha);

            addToHistory(domain);
            return;
        }

        // Reset all loading/data state
        setLoading(true);
        setError(null);
        setData(null);
        setTechStack(null);
        setLushaRequested(false);
        setLushaLoading(false);
        setLushaError(null);
        setLushaData(null);
        setScrapedLoading(false);
        setScrapedCompany(null);
        setRedirectingParent(null);
        setRetryingStatus(null);
        setPageSpeedMobile(null);
        setPageSpeedDesktop(null);
        setPageSpeedLoading(true);
        setPageSpeedStarted(true);
        setTrafficLoading(true);
        setTechLoading(true);

        // Set active domain for race condition handling
        activeSearchDomain.current = domain;
        cache[cleanSearch] = { traffic: null, tech: null, lusha: null, scraped: null };

        const currentSearch = cleanSearch;

        // 0. PageSpeed Insights
        const runPageSpeedAudit = (targetDomain) => {
            setPageSpeedLoading(true);
            let psResolvedCount = 0;
            const PSI_KEY = import.meta.env.VITE_PAGESPEED_KEY || 'AIzaSyAwLB1oZ9dO36LsDzWdBiknSRtLmYOAoCw';
            const PSI_FIELDS = 'lighthouseResult/categories/performance/score,lighthouseResult/audits/first-contentful-paint,lighthouseResult/audits/largest-contentful-paint,lighthouseResult/audits/cumulative-layout-shift,lighthouseResult/audits/total-blocking-time,lighthouseResult/audits/speed-index';

            ['mobile', 'desktop'].forEach(type => {
                const runAudit = async (d) => {
                    const tryUrls = [
                        `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${d}/&key=${PSI_KEY}&category=performance&strategy=${type}&fields=${encodeURIComponent(PSI_FIELDS)}`,
                        `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://www.${d}/&key=${PSI_KEY}&category=performance&strategy=${type}&fields=${encodeURIComponent(PSI_FIELDS)}`,
                        `/api/pagespeed?domain=${d}&strategy=${type}`
                    ];
                    for (const url of tryUrls) {
                        try {
                            const res = await axios.get(url, { timeout: 45000 });
                            if (res.data?.lighthouseResult) return res.data;
                        } catch (e) { }
                    }
                    throw new Error('All PageSpeed attempts failed');
                };

                withRetry(() => runAudit(targetDomain), { maxRetries: 2, initialDelay: 1000 }).then(data => {
                    if (activeSearchDomain.current === domain) {
                        if (type === 'mobile') setPageSpeedMobile(data);
                        else setPageSpeedDesktop(data);
                        if (!cache[currentSearch]) cache[currentSearch] = {};
                        cache[currentSearch][`pageSpeed_${type}`] = data;
                    }
                }).finally(() => {
                    if (activeSearchDomain.current === domain) {
                        psResolvedCount++;
                        if (psResolvedCount === 2) setPageSpeedLoading(false);
                    }
                });
            });
        };

        const normalizedDomain = currentSearch.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
        runPageSpeedAudit(normalizedDomain);

        // 1. Traffic API
        const fetchTraffic = async (targetDomain) => {
            const normalized = targetDomain.replace(/^www\./i, '');
            return withRetry(() => axios.get(`/api/zyla/api/29/site+traffic+api/93/traffic+source+and+overview`, {
                params: { domain: normalized },
                headers: { 'Authorization': `Bearer ${import.meta.env.VITE_ZYLALABS_KEY || '10095|mmrDs2Whvlc7fD1JKYF2CasMOSaDUZxnVkqhHEzp'}` },
                timeout: 25000
            }), {
                maxRetries: 3,
                onRetry: (count) => setRetryingStatus(`Retrying Traffic API (${count}/3)...`)
            });
        };

        const hasTrafficData = (d) => !!(d && (d.Engagments || d.EstimatedMonthlyVisits));

        fetchTraffic(domain).then(async (res) => {
            if (activeSearchDomain.current !== domain) return;

            let trafficData = res.data;

            if (!hasTrafficData(trafficData) && domain.split('.').length > 2) {
                const root = getDomainRoot(domain);
                console.log(`No direct traffic found for ${domain}. Trying root: ${root}`);
                try {
                    const rootRes = await fetchTraffic(root);
                    if (hasTrafficData(rootRes.data)) {
                        trafficData = rootRes.data;
                    }
                } catch (e) {
                    console.error("Root traffic fallback failed:", e);
                }
            }

            if (activeSearchDomain.current === domain) {
                if (hasTrafficData(trafficData)) {
                    setData(trafficData);
                    cache[currentSearch].traffic = trafficData;
                    setRetryingStatus(null);
                } else {
                    console.warn(`Zylalabs returned no traffic data for ${domain} or its root.`);
                    setData(null);
                }
            }
        }).catch(err => {
            console.error("Traffic API failed:", err);
            if (activeSearchDomain.current === domain) {
                setData(null);
                setRetryingStatus("Traffic data unavailable for this domain.");
                setTimeout(() => setRetryingStatus(null), 5000);
            }
        }).finally(() => {
            const currentRelevant = activeSearchDomain.current === domain ||
                (cache[currentSearch]?.scraped?.potentialParentWebsites?.includes(activeSearchDomain.current));
            if (currentRelevant) setTrafficLoading(false);
        });

        // 2. BuiltWith API
        const fetchBuiltWith = async (targetDomain) => {
            console.log(`Attempting BuiltWith lookup for: ${targetDomain}`);
            return withRetry(() => axios.get(`/api/builtwith/v22/api.json`, {
                params: {
                    KEY: import.meta.env.VITE_BUILTWITH_KEY || 'ea894525-80c8-4320-b284-44f5eb507593',
                    LOOKUP: targetDomain
                }
            }), {
                onRetry: (count) => setRetryingStatus(`Retrying Tech Stack API (${count}/3)...`)
            });
        };

        fetchBuiltWith(domain).then(async (res) => {
            if (activeSearchDomain.current !== domain) return;

            console.log("BuiltWith raw response:", res.data);
            let results = res.data?.Results;

            const getTechList = (resObj) => {
                if (!resObj) return null;
                const pathTechs = resObj.Result?.Paths?.flatMap(p => p.Technologies) || [];
                const topLevelTechs = resObj.Result?.Technologies || [];
                const combined = [...pathTechs, ...topLevelTechs];
                return combined.length > 0 ? combined : null;
            };

            let techList = getTechList(results?.[0]);

            if (!techList && domain.split('.').length > 2) {
                const root = getDomainRoot(domain);
                console.log(`No data found for ${domain}. Retrying with root domain: ${root}`);
                const rootRes = await fetchBuiltWith(root);
                results = rootRes.data?.Results;
                techList = getTechList(results?.[0]);
            }

            if (techList) {
                const tech = processTech(techList);
                setTechStack(tech);
                cache[currentSearch].tech = tech;
                setRetryingStatus(null);
            } else {
                console.warn(`BuiltWith returned no technology data for ${domain} or its root.`);
                setTechStack(null);
            }
        }).catch(err => {
            console.error("Tech Stack API failed:", err);
            setTechStack(null);
        }).finally(() => {
            const currentRelevant = activeSearchDomain.current === domain ||
                (cache[currentSearch]?.scraped?.potentialParentWebsites?.includes(activeSearchDomain.current));
            if (currentRelevant) setTechLoading(false);
        });

        // Lusha is now manual - handled by handleLushaUnlock
        setLoading(false);
        addToHistory(domain);
    };

    const copyToSheets = async () => {
        if (!domain || !data) return;

        const cleanD = domain.toLowerCase().trim();

        // 1. Get History (Last 3 months sorted - raw numbers)
        const visitsData = data.EstimatedMonthlyVisits || {};
        const sortedMonths = Object.keys(visitsData).sort((a, b) => new Date(b) - new Date(a)).slice(0, 3);
        const monthViews = sortedMonths.map(m => visitsData[m] || 0);
        while (monthViews.length < 3) monthViews.push(0);

        // 2. Traffic Metrics (raw numbers)
        const engagements = data.Engagments || {};
        const totalVisitsCount = engagements.Visits ? parseInt(engagements.Visits, 10) : (sortedMonths.length > 0 ? visitsData[sortedMonths[0]] : 0);
        const ppv = engagements.PagePerVisit ? parseFloat(engagements.PagePerVisit) : 1.5;
        const pageViews = totalVisitsCount ? Math.round(totalVisitsCount * ppv) : 0;

        // 3. Performance
        const perfMobile = pageSpeedMobile?.lighthouseResult?.categories?.performance?.score ? Math.round(pageSpeedMobile.lighthouseResult.categories.performance.score * 100) + '%' : 'N/A';
        const perfDesktop = pageSpeedDesktop?.lighthouseResult?.categories?.performance?.score ? Math.round(pageSpeedDesktop.lighthouseResult.categories.performance.score * 100) + '%' : 'N/A';

        // 4. Extract CMS and CDN (Case-insensitive)
        const findTechNames = (catName) => {
            const entry = Object.entries(techStack || {}).find(([k]) => k.toLowerCase() === catName.toLowerCase());
            return entry ? entry[1].map(t => t.Name).join(', ').replace(/\t|\n/g, ' ') : 'None';
        };

        const cms = findTechNames('cms');
        const cdn = findTechNames('cdn');

        const finalHeaders = [
            'Domain',
            ...(sortedMonths.length > 0 ? sortedMonths.map(m => `Visits (${m})`) : ['Visits (M1)', 'Visits (M2)', 'Visits (M3)']),
            'Latest Page Views',
            'CMS',
            'CDN',
            'Perf (Mob)',
            'Perf (Desk)'
        ];

        const values = [
            cleanD,
            ...monthViews,
            pageViews,
            cms,
            cdn,
            perfMobile,
            perfDesktop
        ];

        const tsvString = [finalHeaders.join('\t'), values.join('\t')].join('\n');
        try {
            await navigator.clipboard.writeText(tsvString);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy: ', err);
        }
    };

    const handleRetryPageSpeed = () => {
        if (!domain) return;
        const normalizedDomain = domain.toLowerCase().trim().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');

        setPageSpeedLoading(true);
        setPageSpeedStarted(true);
        let psResolvedCount = 0;
        const PSI_KEY = import.meta.env.VITE_PAGESPEED_KEY || '';
        const PSI_FIELDS = 'lighthouseResult/categories/performance/score,lighthouseResult/audits/first-contentful-paint,lighthouseResult/audits/largest-contentful-paint,lighthouseResult/audits/cumulative-layout-shift,lighthouseResult/audits/total-blocking-time,lighthouseResult/audits/speed-index';

        ['mobile', 'desktop'].forEach(type => {
            const runAudit = async (targetDomain) => {
                const tryUrls = [
                    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${targetDomain}/&key=${PSI_KEY}&category=performance&strategy=${type}&fields=${encodeURIComponent(PSI_FIELDS)}`,
                    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://www.${targetDomain}/&key=${PSI_KEY}&category=performance&strategy=${type}&fields=${encodeURIComponent(PSI_FIELDS)}`,
                    `/api/pagespeed?domain=${targetDomain}&strategy=${type}&refresh=true`
                ];

                for (const url of tryUrls) {
                    try {
                        const res = await axios.get(url, { timeout: 45000 });
                        if (res.data?.lighthouseResult) return res.data;
                    } catch (e) { }
                }
                throw new Error('Retry failed');
            };

            // Clear current states and cache entries for this specific retry
            if (type === 'mobile') setPageSpeedMobile(null);
            else setPageSpeedDesktop(null);

            const cleanSearch = domain.toLowerCase().trim();
            if (cache[cleanSearch]) {
                delete cache[cleanSearch][`pageSpeed_${type}`];
            }

            runAudit(normalizedDomain).then(data => {
                if (type === 'mobile') setPageSpeedMobile(data);
                else setPageSpeedDesktop(data);
                if (cache[cleanSearch]) cache[cleanSearch][`pageSpeed_${type}`] = data;
            }).catch(e => console.error(e)).finally(() => {
                psResolvedCount++;
                if (psResolvedCount === 2) setPageSpeedLoading(false);
            });
        });
    };

    const handleLushaUnlock = async () => {
        if (!domain || activeSearchDomain.current !== domain) return;
        setLushaRequested(true);
        setLushaLoading(true);
        setLushaError(null);

        const currentSearch = domain.toLowerCase().trim();

        searchDecisionMakers(domain, {
            onRetry: (status) => setRetryingStatus(`Retrying: ${status}`)
        })
            .then(async (lushaResults) => {
                if (activeSearchDomain.current !== domain) return;

                setLushaData(lushaResults);
                cache[currentSearch].lusha = lushaResults;
                setRetryingStatus(null);

                if (!lushaResults || !lushaResults.contacts || lushaResults.contacts.length === 0) {
                    setScrapedLoading(true);

                    try {
                        let scraperData = null;

                        const cleanD = domain.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
                        const KB = {
                            'footballinsider247.com': { name: 'Breaking Media Ltd', potentialParentWebsites: ['breakingmedialimited.com', 'breakingmedia.com', 'breakingmedialimted.com', 'grv.media'] },
                            'footballinsider.co.uk': { name: 'Breaking Media Ltd', potentialParentWebsites: ['breakingmedialimited.com', 'breakingmedia.com', 'breakingmedialimted.com', 'grv.media'] },
                            'abovethelaw.com': { name: 'Breaking Media, Inc.', potentialParentWebsites: ['breakingmedia.com', 'breakingmedialimited.com'] },
                            'fashionista.com': { name: 'The Arena Group', potentialParentWebsites: ['thearenagroup.net', 'arenagroup.com'] },
                            'dealbreaker.com': { name: 'Breaking Media', potentialParentWebsites: ['breakingmedia.com', 'breakingmedialimited.com'] },
                            'medcitynews.com': { name: 'Breaking Media', potentialParentWebsites: ['breakingmedia.com', 'breakingmedialimited.com'] },
                            'breakingdefense.com': { name: 'Breaking Media', potentialParentWebsites: ['breakingmedia.com', 'breakingmedialimited.com'] },
                            'westhamzone.com': { name: 'Breaking Media Ltd', potentialParentWebsites: ['breakingmedialimited.com', 'breakingmedia.com', 'breakingmedialimted.com'] }
                        };

                        if (KB[cleanD]) {
                            scraperData = { ...KB[cleanD], parentWebsite: KB[cleanD].potentialParentWebsites[0] };
                        } else {
                            try {
                                const res = await axios.get('/api/scrape', { params: { domain }, timeout: 5000 });
                                scraperData = res.data;
                            } catch (e) {
                                scraperData = await scrapeLegal(domain);
                            }
                        }

                        if (scraperData) {
                            setScrapedCompany(scraperData);
                            cache[currentSearch].scraped = scraperData;

                            if (scraperData.potentialParentWebsites && scraperData.potentialParentWebsites.length > 0) {
                                const parents = scraperData.potentialParentWebsites;
                                for (const parent of parents) {
                                    if (activeSearchDomain.current !== domain && !parents.includes(activeSearchDomain.current)) break;
                                    if (parent.toLowerCase() === domain.toLowerCase()) continue;

                                    setRedirectingParent(parent);
                                    activeSearchDomain.current = parent;
                                    setLushaLoading(true);

                                    try {
                                        const parentLushaResults = await searchDecisionMakers(parent, {
                                            onRetry: (status) => setRetryingStatus(`Retrying Parent (${parent}): ${status}`),
                                            isParent: true,
                                            companyName: scraperData.name
                                        });

                                        if (parentLushaResults && parentLushaResults.contacts && parentLushaResults.contacts.length > 0) {
                                            if (activeSearchDomain.current === parent) {
                                                setLushaData(parentLushaResults);
                                                cache[currentSearch].lusha = parentLushaResults;
                                                scraperData.parentWebsite = parent;
                                                setScrapedCompany(scraperData);
                                                break;
                                            }
                                        }
                                    } catch (e) { }
                                }
                            }

                            const currentLushaData = cache[currentSearch].lusha;
                            if ((!currentLushaData || !currentLushaData.contacts || currentLushaData.contacts.length === 0) && scraperData.name) {
                                setRedirectingParent(`Name: ${scraperData.name}`);
                                setLushaLoading(true);

                                try {
                                    const nameResults = await searchDecisionMakers(null, {
                                        isParent: true,
                                        companyName: scraperData.name
                                    });

                                    if (nameResults && nameResults.contacts && nameResults.contacts.length > 0) {
                                        if (activeSearchDomain.current === domain || scraperData.potentialParentWebsites?.includes(activeSearchDomain.current)) {
                                            setLushaData(nameResults);
                                            cache[currentSearch].lusha = nameResults;
                                            setScrapedCompany(scraperData);
                                        }
                                    }
                                } catch (e) { }
                            }
                        }
                    } catch (scraperErr) {
                    } finally {
                        setScrapedLoading(false);
                        setRedirectingParent(null);
                        setRetryingStatus(null);
                        setLushaLoading(false);
                    }
                } else {
                    setScrapedLoading(false);
                    setLushaLoading(false);
                    setScrapedCompany(null);
                }
            })
            .catch(err => {
                if (activeSearchDomain.current === domain) {
                    setLushaError(err.message);
                    setLushaLoading(false);
                }
            });
    };

    // Helper to format large numbers
    const formatNumber = (num) => {
        if (!num || isNaN(num)) return '—';
        return new Intl.NumberFormat('en-US', { notation: "compact", compactDisplay: "short" }).format(num);
    };

    // Helper to format date
    const formatDate = (dateString) => {
        return new Date(dateString).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    };

    return (
        <div className="min-h-screen bg-slate-900 text-white flex flex-col items-center py-10 px-4 font-sans selection:bg-indigo-500 selection:text-white">
            <nav className="mb-10 flex gap-1 p-1 bg-slate-800/50 backdrop-blur rounded-xl border border-slate-700/50 shadow-lg">
                <button
                    onClick={() => setActiveTab('single')}
                    className={`px-8 py-2.5 rounded-lg font-bold transition-all duration-300 ${activeTab === 'single'
                        ? 'bg-indigo-600 text-white shadow-lg'
                        : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                        }`}
                >
                    Single Search
                </button>
                <button
                    onClick={() => setActiveTab('bulk')}
                    className={`px-8 py-2.5 rounded-lg font-bold transition-all duration-300 ${activeTab === 'bulk'
                        ? 'bg-cyan-600 text-white shadow-lg'
                        : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                        }`}
                >
                    Bulk Results
                </button>
            </nav>

            {/* Separate History Button (Top Right) */}
            <div className="fixed top-6 right-6 z-40">
                <button
                    onClick={() => setIsHistoryOpen(true)}
                    className="p-3 bg-slate-800/80 hover:bg-slate-700 backdrop-blur-md rounded-full border border-slate-700/50 text-slate-400 hover:text-indigo-400 transition-all duration-300 shadow-xl group"
                    title="View History"
                >
                    <svg className="w-6 h-6 transition-transform group-hover:rotate-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                </button>
            </div>

            <main className={`w-full ${activeTab === 'bulk' ? 'max-w-6xl' : 'max-w-2xl'} flex flex-col items-center transition-all duration-500`}>
                {activeTab === 'single' ? (
                    <>
                        <form onSubmit={handleAnalyze} className="w-full mb-10 relative group flex gap-3">
                            <div className="relative flex-grow group">
                                <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-cyan-400 rounded-lg blur opacity-25 group-hover:opacity-100 transition duration-1000 group-hover:duration-200"></div>
                                <div className="relative flex items-center bg-slate-800 rounded-lg ring-1 ring-slate-700/50 shadow-2xl">
                                    <div className="flex items-center pl-2">
                                        <button
                                            type="button"
                                            onClick={() => loadFromHistory(historyIndex - 1)}
                                            disabled={historyIndex <= 0}
                                            className="p-2 text-slate-500 hover:text-indigo-400 transition-colors disabled:opacity-30 disabled:hover:text-slate-500"
                                            title="Go Back"
                                        >
                                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
                                            </svg>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => loadFromHistory(historyIndex + 1)}
                                            disabled={historyIndex >= searchHistory.length - 1}
                                            className="p-2 text-slate-500 hover:text-indigo-400 transition-colors disabled:opacity-30 disabled:hover:text-slate-500"
                                            title="Go Forward"
                                        >
                                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                                            </svg>
                                        </button>
                                    </div>
                                    <input
                                        type="text"
                                        className="flex-grow bg-transparent text-white placeholder-slate-500 px-4 py-3 focus:outline-none text-lg"
                                        placeholder="e.g., google.com"
                                        value={domain}
                                        onChange={(e) => setDomain(e.target.value)}
                                    />
                                    <button
                                        type="submit"
                                        disabled={loading || trafficLoading || techLoading || lushaLoading}
                                        className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-md font-semibold transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-indigo-500/30 m-1"
                                    >
                                        {loading || trafficLoading || techLoading || lushaLoading ? (
                                            <span className="flex items-center gap-2">
                                                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                                </svg>
                                                Analyzing...
                                            </span>
                                        ) : (
                                            'Analyze'
                                        )}
                                    </button>
                                </div>
                            </div>
                        </form>

                        {retryingStatus && (
                            <div className="w-full bg-amber-500/10 border border-amber-500/50 text-amber-200 p-4 rounded-lg mb-8 text-center animate-pulse backdrop-blur-sm flex items-center justify-center gap-2">
                                <svg className="animate-spin h-4 w-4 text-amber-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                {retryingStatus}
                            </div>
                        )}

                        {error && (
                            <div className="w-full bg-red-500/10 border border-red-500/50 text-red-200 p-4 rounded-lg mb-8 text-center animate-fade-in backdrop-blur-sm">
                                {error}
                            </div>
                        )}

                        {redirectingParent && (
                            <div className="w-full bg-indigo-500/10 border border-indigo-500/50 text-indigo-200 p-4 rounded-lg mb-8 text-center animate-fade-in backdrop-blur-sm flex items-center justify-center gap-2">
                                <svg className="animate-spin h-4 w-4 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Found Parent Company: <span className="font-bold text-white">{redirectingParent}</span>. Fetching accurate data...
                            </div>
                        )}

                        {data && (data.Engagments?.Visits || data.EstimatedMonthlyVisits) && (
                            <div className="w-full animate-slide-up">
                                <div className="bg-slate-800/80 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden">
                                    <div className="p-6 border-b border-slate-700/50 flex justify-between items-center bg-gradient-to-r from-slate-800 to-slate-900">
                                        <div className="flex flex-col">
                                            <h2 className="text-xl font-bold text-white flex items-center gap-2">
                                                <span className="w-2 h-6 bg-cyan-400 rounded-full"></span>
                                                Traffic Overview
                                            </h2>
                                            <p className="text-[10px] text-slate-500 font-bold ml-4 uppercase tracking-wider italic">
                                                Analysis for {new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <button
                                                onClick={copyToSheets}
                                                className={`text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-1.5 px-3 py-1.5 rounded-lg border ${copied ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400' : 'bg-slate-900/50 border-slate-700/50 text-slate-400 hover:text-white hover:border-slate-500'}`}
                                            >
                                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                                </svg>
                                                {copied ? 'Copied!' : 'Copy to Sheets'}
                                            </button>
                                            <span className="text-xs font-mono text-cyan-400 bg-cyan-400/10 px-2 py-1 rounded border border-cyan-400/20">LIVE DATA</span>
                                        </div>
                                    </div>

                                    <div className="p-6">
                                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
                                            <div className="flex gap-8">
                                                <div>
                                                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">Monthly Visits</p>
                                                    <p className="text-5xl font-black text-white tracking-tight">
                                                        {(() => {
                                                            if (data.Engagments?.Visits) return formatNumber(parseInt(data.Engagments.Visits, 10));
                                                            if (data.EstimatedMonthlyVisits) {
                                                                const dates = Object.keys(data.EstimatedMonthlyVisits).sort((a, b) => new Date(b) - new Date(a));
                                                                if (dates.length > 0) return formatNumber(data.EstimatedMonthlyVisits[dates[0]]);
                                                            }
                                                            return '—';
                                                        })()}
                                                    </p>
                                                    <p className="text-xs text-slate-500 mt-1 font-medium">sessions</p>
                                                </div>
                                                <div>
                                                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1">Page Views</p>
                                                    <p className="text-5xl font-black text-cyan-400 tracking-tight">
                                                        {(() => {
                                                            const visits = data.Engagments?.Visits ? parseInt(data.Engagments.Visits, 10) : (data.EstimatedMonthlyVisits ? Object.values(data.EstimatedMonthlyVisits).pop() : null);
                                                            const ppv = data.Engagments?.PagePerVisit ? parseFloat(data.Engagments.PagePerVisit) : 1.5;
                                                            if (visits) return formatNumber(Math.round(visits * ppv));
                                                            return '—';
                                                        })()}
                                                    </p>
                                                    <p className="text-xs text-slate-500 mt-1 font-medium">total page views</p>
                                                </div>
                                            </div>

                                            <div className="flex flex-wrap gap-3">
                                                {data.GlobalRank?.Rank && (
                                                    <div className="flex flex-col items-center bg-slate-900/60 border border-slate-700/40 rounded-xl px-5 py-3">
                                                        <span className="text-[9px] text-slate-500 font-black uppercase tracking-widest">Global Rank</span>
                                                        <span className="text-2xl font-black text-cyan-400">#{formatNumber(data.GlobalRank.Rank)}</span>
                                                    </div>
                                                )}
                                                {data.CountryRank?.Rank && (
                                                    <div className="flex flex-col items-center bg-slate-900/60 border border-slate-700/40 rounded-xl px-5 py-3">
                                                        <span className="text-[9px] text-slate-500 font-black uppercase tracking-widest">{data.CountryRank.CountryCode || 'Country'} Rank</span>
                                                        <span className="text-2xl font-black text-indigo-400">#{formatNumber(data.CountryRank.Rank)}</span>
                                                    </div>
                                                )}
                                                {data.Engagments?.PagePerVisit && (
                                                    <div className="flex flex-col items-center bg-slate-900/60 border border-slate-700/40 rounded-xl px-5 py-3">
                                                        <span className="text-[9px] text-slate-500 font-black uppercase tracking-widest">Pages / Visit</span>
                                                        <span className="text-2xl font-black text-emerald-400">{parseFloat(data.Engagments.PagePerVisit).toFixed(1)}</span>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {data.EstimatedMonthlyVisits && (
                                        <div className="mt-2 border-t border-slate-700/30 pt-4 px-6 pb-4">
                                            <button
                                                onClick={() => setShowMonthlyVisits(v => !v)}
                                                className="flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-cyan-400 transition-colors mb-4"
                                            >
                                                <svg className={`w-4 h-4 transition-transform duration-300 ${showMonthlyVisits ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                </svg>
                                                {showMonthlyVisits ? 'Hide' : 'Show'} Historical Traffic
                                            </button>

                                            {showMonthlyVisits && (
                                                <div className="overflow-x-auto animate-slide-up">
                                                    <table className="w-full text-left">
                                                        <thead>
                                                            <tr className="border-b border-slate-700/50 text-slate-400 text-[10px] uppercase tracking-wider">
                                                                <th className="px-4 py-2 font-black">Period</th>
                                                                <th className="px-4 py-2 font-black text-right">Traffic Volume</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-slate-700/20">
                                                            {Object.entries(data.EstimatedMonthlyVisits)
                                                                .sort((a, b) => new Date(b[0]) - new Date(a[0]))
                                                                .slice(0, 3)
                                                                .map(([date, visits]) => (
                                                                    <tr key={date} className="hover:bg-slate-700/20 transition-colors">
                                                                        <td className="px-4 py-3 text-slate-300 text-sm font-semibold">{formatDate(date)}</td>
                                                                        <td className="px-4 py-3 text-right text-cyan-400 font-mono text-sm font-bold">{formatNumber(visits)}</td>
                                                                    </tr>
                                                                ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    <div className="px-6 py-3 bg-slate-900/50 text-center text-xs text-slate-500 border-t border-slate-700/50">
                                        Data provided by Zylalabs
                                    </div>
                                </div>
                            </div>
                        )}

                        {techStack && (
                            <div className="w-full mt-8 animate-slide-up animation-delay-200">
                                <div className="bg-slate-800/80 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden">
                                    <div className="p-6 border-b border-slate-700/50 flex justify-between items-center bg-gradient-to-r from-slate-800 to-slate-900">
                                        <h2 className="text-xl font-bold text-white flex items-center gap-2">
                                            <span className="w-2 h-6 bg-indigo-400 rounded-full"></span>
                                            Tech Stack
                                        </h2>
                                        <button
                                            onClick={() => setShowAllTech(!showAllTech)}
                                            className="text-xs font-semibold text-slate-300 hover:text-white transition-colors bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-md border border-slate-600"
                                        >
                                            {showAllTech ? 'Show Less' : 'Show All'}
                                        </button>
                                    </div>

                                    <div className="p-6 grid gap-6 md:grid-cols-2">
                                        {Object.entries(techStack)
                                            .filter(([category]) => {
                                                const cat = category.toLowerCase();
                                                return showAllTech || ['cms', 'cdn', 'mobile', 'ads'].includes(cat);
                                            })
                                            .map(([category, techs]) => (
                                                <div key={category} className="bg-slate-900/50 rounded-lg p-4 border border-slate-700/30">
                                                    <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">{category.replace(/-/g, ' ')}</h3>
                                                    <div className="flex flex-wrap gap-2">
                                                        {(showAllTech ? techs : techs.slice(0, 3)).map((tech, i) => (
                                                            <span key={i} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 relative group/tech" title={tech.Description}>
                                                                {tech.Name}
                                                                {tech.isRecent && (
                                                                    <span className="ml-1.5 flex h-2 w-2">
                                                                        <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-cyan-400 opacity-75"></span>
                                                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
                                                                    </span>
                                                                )}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {loading === false && data && !techStack && !techLoading && (
                            <div className="w-full mt-8 animate-slide-up animation-delay-200">
                                <div className="bg-slate-800/80 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden p-8 text-center text-slate-400">
                                    <p className="text-lg font-medium">No Technology Stack Detected</p>
                                    <p className="text-sm mt-1">BuiltWith could not find any technology profile for this domain.</p>
                                </div>
                            </div>
                        )}

                        {pageSpeedStarted && (
                            <PageSpeedResults
                                mobileData={pageSpeedMobile}
                                desktopData={pageSpeedDesktop}
                                onRetry={handleRetryPageSpeed}
                                loading={pageSpeedLoading}
                            />
                        )}

                        {/* Manual Lusha Unlock Button */}
                        {!lushaRequested && !lushaData && !lushaLoading && (data || techStack) && (
                            <div className="w-full mt-8 animate-slide-up">
                                <div className="bg-gradient-to-br from-slate-800 to-indigo-900/30 backdrop-blur-md rounded-2xl border border-indigo-500/30 p-8 text-center shadow-2xl relative overflow-hidden group">
                                    <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                        <svg className="w-24 h-24 text-indigo-400 rotate-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                                        </svg>
                                    </div>
                                    <div className="relative z-10">
                                        <h3 className="text-xl font-bold text-white mb-2">Find Decision Makers</h3>
                                        <p className="text-slate-300 text-sm mb-6 max-w-md mx-auto">
                                            Click below to find verified decision makers, emails, and phone numbers for this domain using Lusha.
                                        </p>
                                        <button
                                            onClick={handleLushaUnlock}
                                            className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-full font-bold transition-all shadow-lg shadow-indigo-600/30 flex items-center gap-2 mx-auto active:scale-95"
                                        >
                                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                                            </svg>
                                            Reveal Contacts
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        <DecisionMakers
                            results={lushaData?.contacts}
                            companyInfo={lushaData?.companyInfo}
                            scrapedCompany={scrapedCompany}
                            requestId={lushaData?.requestId}
                            loading={lushaLoading}
                            error={lushaError}
                            redirectingParent={redirectingParent}
                        />
                    </>
                ) : (
                    <BulkAnalyzer />
                )}
            </main>

            {/* History Drawer */}
            {isHistoryOpen && (
                <div className="fixed inset-0 z-50 overflow-hidden">
                    <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm transition-opacity" onClick={() => setIsHistoryOpen(false)}></div>
                    <div className="absolute inset-y-0 right-0 max-w-full flex">
                        <div className="w-screen max-w-md bg-slate-800 shadow-2xl flex flex-col animate-slide-left">
                            <div className="px-6 py-6 bg-slate-900 border-b border-slate-700 flex items-center justify-between">
                                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                                    <svg className="w-6 h-6 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    Search History
                                </h3>
                                <button
                                    onClick={() => setIsHistoryOpen(false)}
                                    className="text-slate-400 hover:text-white transition-colors"
                                >
                                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                            <div className="flex-grow overflow-y-auto p-6 space-y-4">
                                {searchHistory.length === 0 ? (
                                    <div className="text-center py-20">
                                        <div className="w-16 h-16 bg-slate-700/50 rounded-full flex items-center justify-center mx-auto mb-4">
                                            <svg className="w-8 h-8 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                        </div>
                                        <p className="text-slate-400 font-medium">No history yet</p>
                                        <p className="text-slate-500 text-xs mt-1">Domains you analyze will appear here.</p>
                                    </div>
                                ) : (
                                    [...searchHistory].reverse().map((histDomain, revIdx) => {
                                        const idx = searchHistory.length - 1 - revIdx;
                                        const isActive = historyIndex === idx;
                                        return (
                                            <button
                                                key={idx}
                                                onClick={() => {
                                                    loadFromHistory(idx);
                                                    setIsHistoryOpen(false);
                                                }}
                                                className={`w-full text-left p-4 rounded-xl border transition-all duration-300 flex items-center justify-between group ${isActive
                                                    ? 'bg-indigo-600/20 border-indigo-500 text-white'
                                                    : 'bg-slate-700/30 border-slate-700 hover:border-slate-500 text-slate-300 hover:bg-slate-700/50'
                                                    }`}
                                            >
                                                <div className="flex items-center gap-3">
                                                    <div className={`w-2 h-2 rounded-full ${isActive ? 'bg-indigo-400 animate-pulse' : 'bg-slate-600'}`}></div>
                                                    <span className="font-bold truncate max-w-[200px]">{histDomain}</span>
                                                </div>
                                                <svg className={`w-5 h-5 transition-transform duration-300 ${isActive ? 'text-indigo-400' : 'text-slate-600 group-hover:translate-x-1'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                                                </svg>
                                            </button>
                                        );
                                    })
                                )}
                            </div>
                            <div className="p-6 bg-slate-900/50 border-t border-slate-700 text-center">
                                <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">History stored in this session</p>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function PageSpeedResults({ mobileData, desktopData, onRetry, loading }) {
    const [strategy, setStrategy] = useState('mobile');
    const data = strategy === 'mobile' ? mobileData : desktopData;

    if (loading && !mobileData && !desktopData) {
        return (
            <div className="w-full mt-8 bg-slate-800/50 backdrop-blur-md rounded-2xl border border-indigo-500/30 p-8 text-center animate-pulse">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin"></div>
                    <div>
                        <h3 className="text-lg font-bold text-white">Running Google PageSpeed Audit</h3>
                        <p className="text-slate-400 text-sm mt-1">Analyzing both Mobile and Desktop performance (~1 min)...</p>
                    </div>
                </div>
            </div>
        );
    }

    if (!mobileData && !desktopData && !loading) {
        return (
            <div className="w-full mt-8 bg-slate-800/50 backdrop-blur-md rounded-2xl border border-slate-700/50 p-8 text-center animate-slide-up">
                <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 bg-slate-700/50 rounded-full flex items-center justify-center">
                        <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white">Performance Audit Failed</h3>
                        <p className="text-slate-400 text-sm mt-1">We couldn't retrieve PageSpeed data for this domain.</p>
                        <button
                            onClick={onRetry}
                            className="mt-4 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 px-6 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2 mx-auto"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            Retry Performance Audit
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (!mobileData && !desktopData) return null;

    const experiences = data?.loadingExperience || data?.originLoadingExperience;
    const metrics = experiences?.metrics;
    const perfScore = data?.lighthouseResult?.categories?.performance?.score;
    const assessmentStatus = experiences?.overall_category;

    const getOverallStatus = () => {
        if (assessmentStatus === 'FAST') return 'Passed';
        if (perfScore !== undefined && perfScore !== null) {
            if (perfScore >= 0.8) return 'Passed';
            if (perfScore >= 0.5) return 'Needs Improvement';
            return 'Failed';
        }
        if (assessmentStatus === 'SLOW') return 'Failed';
        if (assessmentStatus === 'AVERAGE') return 'Needs Improvement';
        return 'No Data';
    };

    const overallStatus = getOverallStatus();
    const overallCategory = assessmentStatus || (perfScore >= 0.8 ? 'FAST' : perfScore >= 0.5 ? 'AVERAGE' : 'SLOW');

    const getStatusColor = (cat) => {
        if (!cat) return 'text-slate-400';
        const c = cat.toUpperCase();
        if (c === 'FAST' || c === 'GOOD') return 'text-emerald-400';
        if (c === 'AVERAGE' || c === 'NEEDS_IMPROVEMENT') return 'text-amber-400';
        return 'text-red-400';
    };

    const getStatusBg = (cat) => {
        if (!cat) return 'bg-slate-400/10';
        const c = cat.toUpperCase();
        if (c === 'FAST' || c === 'GOOD') return 'bg-emerald-400/10';
        if (c === 'AVERAGE' || c === 'NEEDS_IMPROVEMENT') return 'bg-amber-400/10';
        return 'bg-red-400/10';
    };

    const MetricCard = ({ metric, isMain = true }) => {
        const m = metrics?.[metric.id];
        const val = m ? (m.percentile / metric.divisor).toFixed(metric.divisor === 1 ? (metric.id.includes('SCORE') ? 2 : 0) : 1) : '—';
        const category = m?.category || 'N/A';
        const colorClass = getStatusColor(category);

        // Progress bar logic
        const getProgress = () => {
            if (category === 'FAST' || category === 'GOOD') return '30%';
            if (category === 'AVERAGE' || category === 'NEEDS_IMPROVEMENT') return '65%';
            if (category === 'SLOW' || category === 'POOR') return '95%';
            return '0%';
        };

        const getBarGradient = () => {
            return `linear-gradient(to right, #10b981 0%, #10b981 33.33%, #fbbf24 33.33%, #fbbf24 66.66%, #ef4444 66.66%, #ef4444 100%)`;
        };

        if (!isMain) {
            return (
                <div className="bg-slate-900/40 rounded-xl p-6 border border-slate-700/20 flex justify-between items-center">
                    <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">{metric.label} ({metric.short})</h4>
                    <p className={`text-2xl font-black ${colorClass}`}>
                        {val} <span className="text-xs font-normal text-slate-500 ml-0.5">{metric.unit}</span>
                    </p>
                </div>
            );
        }

        return (
            <div className="bg-slate-900/40 rounded-xl p-6 border border-slate-700/20 flex flex-col">
                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">{metric.label} ({metric.short})</h4>
                <div className="flex items-baseline gap-1 mt-2 mb-4">
                    <span className={`text-4xl font-black ${colorClass}`}>{val}</span>
                    <span className="text-sm font-normal text-slate-500">{metric.unit}</span>
                </div>

                {/* Progress Bar Container */}
                <div className="relative h-1.5 w-full rounded-full overflow-hidden mb-2" style={{ background: '#1e293b' }}>
                    <div className="absolute inset-0 z-0 h-full w-full" style={{ background: getBarGradient(), opacity: 0.8 }} />
                    {/* Indicator */}
                    <div
                        className="absolute h-full w-1.5 bg-white z-10 shadow-[0_0_8px_rgba(255,255,255,0.8)] transition-all duration-1000"
                        style={{ left: `calc(${getProgress()} - 0.75px)` }}
                    />
                </div>

                <div className="flex justify-between text-[8px] font-black text-slate-600 uppercase tracking-widest mb-6">
                    <span>Good</span>
                    <span>Poor</span>
                </div>

                <div className="mt-auto pt-4 border-t border-slate-800/50 flex justify-between items-center">
                    <div>
                        <p className="text-[8px] font-black text-slate-600 uppercase tracking-widest leading-tight">75th Percentile -</p>
                        <p className="text-[10px] font-bold text-slate-500">{val}{metric.unit}</p>
                    </div>
                    {(category === 'FAST' || category === 'GOOD') && (
                        <span className="text-[8px] font-black text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded border border-emerald-400/20 tracking-tighter">FAST</span>
                    )}
                </div>
            </div>
        );
    };

    const cwvis = [
        { id: 'LARGEST_CONTENTFUL_PAINT_MS', label: 'Largest Contentful Paint', short: 'LCP', unit: 's', divisor: 1000 },
        { id: 'INTERACTION_TO_NEXT_PAINT', label: 'Interaction to Next Paint', short: 'INP', unit: 'ms', divisor: 1 },
        { id: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', label: 'Cumulative Layout Shift', short: 'CLS', unit: '', divisor: 100 },
    ];

    const notableMetrics = [
        { id: 'FIRST_CONTENTFUL_PAINT_MS', label: 'FIRST CONTENTFUL PAINT', short: 'FCP', unit: 's', divisor: 1000 },
        { id: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE', label: 'TIME TO FIRST BYTE', short: 'TTFB', unit: 's', divisor: 1000 },
    ];

    return (
        <div className="w-full mt-8 animate-slide-up">
            <div className="bg-slate-800/80 backdrop-blur-md rounded-3xl border border-slate-700/50 shadow-2xl overflow-hidden">
                {/* Header Section */}
                <div className="p-8 pb-4">
                    <div className="flex justify-between items-start mb-6">
                        <div className="flex items-center gap-5">
                            <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20">
                                <svg className="w-7 h-7 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" />
                                </svg>
                            </div>
                            <div>
                                <h2 className="text-2xl font-black text-white tracking-tight">Core Web Vitals Assessment</h2>
                                <div className="flex items-center gap-3 mt-1">
                                    <span className={`text-base font-bold ${getStatusColor(overallCategory)}`}>{overallStatus}</span>
                                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] pt-0.5">Performance Score: <span className={getStatusColor(overallCategory)}>{data ? Math.round(data.lighthouseResult?.categories?.performance?.score * 100) : '—'}%</span></span>
                                </div>
                            </div>
                        </div>

                        <div className="flex bg-slate-900/80 rounded-xl p-1 border border-slate-700/50">
                            {['mobile', 'desktop'].map(s => (
                                <button
                                    key={s}
                                    onClick={() => setStrategy(s)}
                                    className={`px-5 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${strategy === s ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {!data ? (
                    <div className="px-8 pb-12 text-center text-slate-500 text-sm italic">
                        No {strategy} data available for this domain.
                    </div>
                ) : (
                    <div className="px-8 pb-8">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                            {cwvis.map(m => (
                                <MetricCard key={m.id} metric={m} />
                            ))}
                        </div>

                        <div className="mb-4">
                            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4">Other Notable Metrics</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {notableMetrics.map(m => (
                                    <MetricCard key={m.id} metric={m} isMain={false} />
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* Footer */}
                <div className="px-8 py-5 bg-slate-900/80 flex justify-between items-center border-t border-slate-700/50">
                    <span className="text-[9px] text-slate-600 font-black uppercase tracking-[0.2em] italic">Lighthouse Engine {data?.lighthouseResult?.lighthouseVersion || '13.0.1'}</span>
                    <span className="text-[9px] text-slate-600 font-black uppercase tracking-[0.2em]">Performance Score: <span className={getStatusColor(overallCategory)}>{data ? Math.round(data.lighthouseResult?.categories?.performance?.score * 100) : '—'}%</span></span>
                </div>
            </div>
        </div>
    );
};

export default App;
