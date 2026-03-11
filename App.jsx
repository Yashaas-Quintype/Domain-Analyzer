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
    const [trafficLoading, setTrafficLoading] = useState(false);
    const [techLoading, setTechLoading] = useState(false);

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
        setTrafficLoading(true);
        setTechLoading(true);

        // Set active domain for race condition handling
        activeSearchDomain.current = domain;
        cache[cleanSearch] = { traffic: null, tech: null, lusha: null, scraped: null };

        const currentSearch = cleanSearch;

        // 0. PageSpeed Insights
        setPageSpeedLoading(true);
        setTrafficLoading(true);
        setTechLoading(true);
        setLushaLoading(false); // Lusha is now manual

        const strategies = ['mobile', 'desktop'];
        let psResolvedCount = 0;
        const PSI_KEY = import.meta.env.VITE_PAGESPEED_KEY || 'AIzaSyAwLB1oZ9dO36LsDzWdBiknSRtLmYOAoCw';
        const PSI_FIELDS = 'loadingExperience,originLoadingExperience,lighthouseResult.categories.performance.score,lighthouseResult.lighthouseVersion';

        if (!PSI_KEY) {
            console.warn('PageSpeed API key missing - skipping PageSpeed analysis');
            setPageSpeedLoading(false);
        } else {
            const normalizedDomain = currentSearch.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];

            const safetyTimer = setTimeout(() => {
                if (psResolvedCount < 2) {
                    console.warn("PageSpeed Insight scan timed out after 60s");
                    setPageSpeedLoading(false);
                }
            }, 60000);

            strategies.forEach(type => {
                if (cache[currentSearch]?.[`pageSpeed_${type}`]) {
                    const cachedData = cache[currentSearch][`pageSpeed_${type}`];
                    if (type === 'mobile') setPageSpeedMobile(cachedData);
                    else setPageSpeedDesktop(cachedData);
                    psResolvedCount++;
                    if (psResolvedCount === 2) {
                        clearTimeout(safetyTimer);
                        setPageSpeedLoading(false);
                    }
                    return;
                }

                const runAudit = async (targetDomain) => {
                    const tryUrls = [
                        // Try 1: Direct Google API (works on localhost and Vercel)
                        `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${targetDomain}/&key=${PSI_KEY}&category=performance&strategy=${type}&fields=${encodeURIComponent(PSI_FIELDS)}`,
                        // Try 2: www. prefix variant
                        `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://www.${targetDomain}/&key=${PSI_KEY}&category=performance&strategy=${type}&fields=${encodeURIComponent(PSI_FIELDS)}`,
                        // Try 3: Via proxy (fallback for Vercel)
                        `/api/pagespeed?domain=${targetDomain}&strategy=${type}`
                    ];

                    let lastErr = null;
                    for (const url of tryUrls) {
                        try {
                            console.log(`PageSpeed [${type}] - Attempting ${url}...`);
                            const res = await axios.get(url, { timeout: 45000 });
                            if (res.data?.lighthouseResult || res.data?.loadingExperience) return res.data;
                        } catch (e) {
                            lastErr = e;
                            console.warn(`PageSpeed [${type}] failed for ${url}:`, e.message);
                        }
                    }
                    throw lastErr || new Error('All PageSpeed attempts failed');
                };

                withRetry(() => runAudit(normalizedDomain), {
                    maxRetries: 2,
                    initialDelay: 3000,
                    onRetry: (count) => console.log(`Retrying PageSpeed [${type}] (${count}/2)...`)
                }).then(data => {
                    if (activeSearchDomain.current === domain) {
                        if (type === 'mobile') setPageSpeedMobile(data);
                        else setPageSpeedDesktop(data);
                        if (!cache[currentSearch]) cache[currentSearch] = {};
                        cache[currentSearch][`pageSpeed_${type}`] = data;
                    }
                }).catch(err => {
                    console.error(`PageSpeed ${type} ultimate failure:`, err.message);
                }).finally(() => {
                    if (activeSearchDomain.current === domain) {
                        psResolvedCount++;
                        if (psResolvedCount === 2) {
                            clearTimeout(safetyTimer);
                            setPageSpeedLoading(false);
                        }
                    }
                });
            });
        }

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

            <main className={`w-full ${activeTab === 'bulk' ? 'max-w-6xl' : 'max-w-2xl'} flex flex-col items-center transition-all duration-500`}>
                {activeTab === 'single' ? (
                    <>
                        <form onSubmit={handleAnalyze} className="w-full mb-10 relative group">
                            <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-cyan-400 rounded-lg blur opacity-25 group-hover:opacity-100 transition duration-1000 group-hover:duration-200"></div>
                            <div className="relative flex items-center bg-slate-800 rounded-lg p-2 ring-1 ring-slate-700/50 shadow-2xl">
                                <input
                                    type="text"
                                    className="flex-grow bg-transparent text-white placeholder-slate-500 px-4 py-3 focus:outline-none text-lg"
                                    placeholder="e.g., google.com"
                                    value={domain}
                                    onChange={(e) => setDomain(e.target.value)}
                                />
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-md font-semibold transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-indigo-500/30"
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
                                        <span className="text-xs font-mono text-cyan-400 bg-cyan-400/10 px-2 py-1 rounded border border-cyan-400/20">LIVE DATA</span>
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

                        {pageSpeedLoading && !pageSpeedMobile && !pageSpeedDesktop && (
                            <div className="w-full mt-8 bg-slate-800/50 backdrop-blur-md rounded-2xl border border-indigo-500/30 p-8 text-center animate-pulse">
                                <div className="flex flex-col items-center gap-4">
                                    <div className="w-12 h-12 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin"></div>
                                    <div>
                                        <h3 className="text-lg font-bold text-white">Running Google PageSpeed Audit</h3>
                                        <p className="text-slate-400 text-sm mt-1">Analyzing both Mobile and Desktop performance (~1 min)...</p>
                                    </div>
                                </div>
                            </div>
                        )}

                        <PageSpeedResults mobileData={pageSpeedMobile} desktopData={pageSpeedDesktop} />

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
        </div>
    );
}

const PageSpeedResults = ({ mobileData, desktopData }) => {
    const [strategy, setStrategy] = useState('mobile');
    const data = strategy === 'mobile' ? mobileData : desktopData;

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

    const cwvis = [
        { id: 'LARGEST_CONTENTFUL_PAINT_MS', label: 'LCP', unit: 's', divisor: 1000, desc: 'Largest Contentful Paint' },
        { id: 'FIRST_INPUT_DELAY_MS', label: 'FID', unit: 'ms', divisor: 1, desc: 'First Input Delay' },
        { id: 'CUMULATIVE_LAYOUT_SHIFT_SCORE', label: 'CLS', unit: '', divisor: 100, desc: 'Cumulative Layout Shift' },
    ];

    const notableMetrics = [
        { id: 'FIRST_CONTENTFUL_PAINT_MS', label: 'First Contentful Paint', unit: 's', divisor: 1000 },
        { id: 'INTERACTION_TO_NEXT_PAINT', label: 'Interaction to Next Paint', unit: 'ms', divisor: 1 },
    ];

    return (
        <div className="w-full mt-8 animate-slide-up">
            <div className="bg-slate-800/80 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden">
                <div className="p-6 border-b border-slate-700/50 flex justify-between items-center bg-gradient-to-r from-slate-800 to-slate-900">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <span className="w-2 h-6 bg-emerald-400 rounded-full"></span>
                        PageSpeed Insights
                    </h2>
                    <div className="flex items-center gap-3">
                        <span className={`text-xs font-black uppercase tracking-widest px-3 py-1 rounded-full border ${overallStatus === 'Passed' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : overallStatus === 'Needs Improvement' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : 'bg-red-500/10 text-red-400 border-red-500/30'}`}>
                            {overallStatus}
                        </span>
                        <div className="flex bg-slate-900/50 rounded-lg p-0.5 border border-slate-700/50">
                            {['mobile', 'desktop'].map(s => (
                                <button key={s} onClick={() => setStrategy(s)}
                                    className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all ${strategy === s ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>
                                    {s.charAt(0).toUpperCase() + s.slice(1)}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {!data ? (
                    <div className="p-8 text-center text-slate-500 text-sm italic">
                        No {strategy} data available.
                    </div>
                ) : (
                    <div className="p-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {cwvis.map(m => (
                                <div key={m.id} className="bg-slate-900/40 rounded-xl p-5 border border-slate-700/20">
                                    <div className="flex justify-between items-start mb-3">
                                        <div>
                                            <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">{m.label}</p>
                                            <p className="text-[9px] text-slate-600">{m.desc}</p>
                                        </div>
                                        <span className={`text-[10px] font-black uppercase tracking-tighter px-1.5 py-0.5 rounded ${getStatusColor(metrics?.[m.id]?.category)} bg-current/10`}>
                                            {metrics?.[m.id]?.category?.replace('_', ' ') || 'N/A'}
                                        </span>
                                    </div>
                                    <p className={`text-3xl font-black ${getStatusColor(metrics?.[m.id]?.category)}`}>
                                        {metrics?.[m.id] ? (metrics?.[m.id]?.percentile / m.divisor).toFixed(m.divisor === 1 ? 0 : 1) : '—'}
                                        <span className="text-sm font-normal text-slate-500 ml-1">{m.unit}</span>
                                    </p>
                                </div>
                            ))}
                        </div>

                        <div className="mt-6">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {notableMetrics.map(m => (
                                    <div key={m.id} className="flex justify-between items-center p-4 bg-slate-900/40 rounded-xl border border-slate-700/20">
                                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-tighter">{m.label}</h4>
                                        <span className={`text-xl font-black ${getStatusColor(metrics?.[m.id]?.category)}`}>
                                            {metrics?.[m.id] ? (metrics?.[m.id]?.percentile / m.divisor).toFixed(m.divisor === 1 ? 0 : 1) : '—'}
                                            <span className="text-[10px] text-slate-500 font-bold ml-1">{m.unit}</span>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                <div className="px-6 py-4 bg-slate-900/50 flex justify-between items-center border-t border-slate-700/50">
                    <span className="text-[9px] text-slate-600 font-bold uppercase tracking-widest italic">Lighthouse Engine {data?.lighthouseResult?.lighthouseVersion || '...'}</span>
                    <span className="text-[9px] text-slate-600 font-bold uppercase tracking-widest">Performance Score: <span className={getStatusColor(overallCategory)}>{data ? Math.round(data.lighthouseResult?.categories?.performance?.score * 100) : '—'}%</span></span>
                </div>
            </div>
        </div>
    );
};

export default App;
