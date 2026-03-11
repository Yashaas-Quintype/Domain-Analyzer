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

    // Detection timing is ignored as per user request to show what they are using currently, 
    // regardless of age. Sorting by date keeps the most likely "latest" at the top of each list.

    // Recent Threshold: 3 months from today's date (kept for visual badges only)
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

            // Check if it's "Recent" (detected in last 3 months)
            const isRecent = tech.LastDetected && tech.LastDetected >= recentThreshold;

            if (!acc[category].find(t => t.Name === tech.Name)) {
                acc[category].push({ ...tech, isRecent });
            }
            return acc;
        }, {});
};

/**
 * Helper to get the root domain from a hostname
 * e.g., blog.hubspot.com -> hubspot.com
 */
const getDomainRoot = (hostname) => {
    if (!hostname) return '';
    const cleaned = hostname.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
    const parts = cleaned.split('.');
    if (parts.length <= 2) return cleaned;

    // Handle multi-part TLDs like .co.uk, .com.au, etc.
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
    const [activeTab, setActiveTab] = useState('single'); // 'single' or 'bulk'

    // Lusha State
    const [lushaData, setLushaData] = useState(null);
    const [lushaLoading, setLushaLoading] = useState(false);
    const [lushaError, setLushaError] = useState(null);

    // Scraper State
    const [scrapedCompany, setScrapedCompany] = useState(null);
    const [scrapedLoading, setScrapedLoading] = useState(false);
    const [redirectingParent, setRedirectingParent] = useState(null);
    const [retryingStatus, setRetryingStatus] = useState(null); // Feedback for API retries
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
        setLushaLoading(true);
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
        setLushaLoading(true);

        // Set active domain for race condition handling
        activeSearchDomain.current = domain;
        cache[cleanSearch] = { traffic: null, tech: null, lusha: null, scraped: null, pageSpeedMobile: null, pageSpeedDesktop: null };

        const currentSearch = cleanSearch;

        // 0. PageSpeed Insights — direct API with fields filter (~10x smaller payload)
        setPageSpeedLoading(true);
        setTrafficLoading(true);
        setTechLoading(true);
        setLushaLoading(true);

        const strategies = ['mobile', 'desktop'];
        let psResolvedCount = 0;
        // Use env var, fall back to hardcoded key to ensure it works on all deployments
        const PSI_KEY = import.meta.env.VITE_PAGESPEED_KEY || 'AIzaSyAwLB1oZ9dO36LsDzWdBiknSRtLmYOAoCw';
        const PSI_FIELDS = 'loadingExperience,originLoadingExperience,lighthouseResult.categories.performance.score,lighthouseResult.lighthouseVersion';

        if (!PSI_KEY) {
            console.warn('PageSpeed API key missing - skipping PageSpeed analysis');
            setPageSpeedLoading(false);
        } else {
            // Normalize domain
            const normalizedDomain = currentSearch.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];

            // Safety timeout to prevent infinite "Running..." state
            const safetyTimer = setTimeout(() => {
                if (psResolvedCount < 2) {
                    console.warn("PageSpeed Insight scan timed out after 45s");
                    setPageSpeedLoading(false);
                }
            }, 45000);

            strategies.forEach(type => {
                // Check frontend cache first
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

                // Try both https versions if needed, but start with the one provided
                const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${normalizedDomain}/&key=${PSI_KEY}&category=performance&strategy=${type}&fields=${encodeURIComponent(PSI_FIELDS)}`;

                axios.get(url, { timeout: 60000 }).then(res => {
                    const data = res.data;
                    if (activeSearchDomain.current === domain) {
                        if (type === 'mobile') setPageSpeedMobile(data);
                        else setPageSpeedDesktop(data);
                        if (!cache[currentSearch]) cache[currentSearch] = {};
                        cache[currentSearch][`pageSpeed_${type}`] = data;
                    }
                }).catch(err => {
                    console.error(`PageSpeed ${type} API failed for ${normalizedDomain}:`, err.message);
                    // Fallback: try with www. if it wasn't there
                    if (!normalizedDomain.startsWith('www.')) {
                        const wwwUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://www.${normalizedDomain}/&key=${PSI_KEY}&category=performance&strategy=${type}&fields=${encodeURIComponent(PSI_FIELDS)}`;
                        axios.get(wwwUrl, { timeout: 30000 }).then(wwwRes => {
                            if (activeSearchDomain.current === domain) {
                                if (type === 'mobile') setPageSpeedMobile(wwwRes.data);
                                else setPageSpeedDesktop(wwwRes.data);
                                if (!cache[currentSearch]) cache[currentSearch] = {};
                                cache[currentSearch][`pageSpeed_${type}`] = wwwRes.data;
                            }
                        }).catch(e => console.error("WWW PageSpeed fallback also failed:", e.message));
                    }
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
            // We strip the hardcoded auth from frontend to let the proxy handle it cleanly via env vars
            return withRetry(() => axios.get(`/api/zyla/api/29/site+traffic+api/93/traffic+source+and+overview`, {
                params: { domain: normalized },
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

            // If no data found and it looks like a subdomain, retry with root
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
            // Let the proxy handle the KEY via env vars, we just pass LOOKUP
            return withRetry(() => axios.get(`/api/builtwith/v22/api.json`, {
                params: { LOOKUP: targetDomain }
            }), {
                onRetry: (count) => setRetryingStatus(`Retrying Tech Stack API (${count}/3)...`)
            });
        };

        fetchBuiltWith(domain).then(async (res) => {
            if (activeSearchDomain.current !== domain) return;

            console.log("BuiltWith raw response:", res.data);
            let results = res.data?.Results;

            // Robust parsing: check for paths array or top-level technologies
            const getTechList = (resObj) => {
                if (!resObj) return null;
                const pathTechs = resObj.Result?.Paths?.flatMap(p => p.Technologies) || [];
                const topLevelTechs = resObj.Result?.Technologies || [];
                const combined = [...pathTechs, ...topLevelTechs];
                return combined.length > 0 ? combined : null;
            };

            let techList = getTechList(results?.[0]);

            // If no tech found for the subdomain/full input, try the root domain
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

        // 3. Lusha API 
        let isStillActive = true;
        searchDecisionMakers(domain, {
            onRetry: (status) => setRetryingStatus(`Retrying: ${status}`)
        })
            .then(async (lushaResults) => {
                // Check if this search is still relevant
                if (activeSearchDomain.current !== domain) {
                    isStillActive = false;
                    return;
                }

                setLushaData(lushaResults);
                cache[currentSearch].lusha = lushaResults;
                setRetryingStatus(null);

                // If no contacts found, THEN and ONLY THEN run the scraper to find a parent
                if (!lushaResults || !lushaResults.contacts || lushaResults.contacts.length === 0) {
                    console.log(`No contacts found for ${domain}. Scanning for parent company fallback...`);
                    setScrapedLoading(true);

                    try {
                        let scraperData = null;

                        // Step A: Check knowledge base locally first
                        // We duplicate the KB logic here for speed and frontend-only operation
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
                            console.log(`✓ (Frontend) Using knowledge base for ${cleanD}`);
                            scraperData = { ...KB[cleanD], parentWebsite: KB[cleanD].potentialParentWebsites[0] };
                        } else {
                            // Step B: Try backend
                            try {
                                const res = await axios.get('/api/scrape', { params: { domain }, timeout: 5000 });
                                scraperData = res.data;
                            } catch (e) {
                                console.warn("Backend scraper failed, trying client-side fallback...");
                                // Step C: Client-side fallback (might fail CORS)
                                scraperData = await scrapeLegal(domain);
                            }
                        }

                        if (scraperData) {
                            setScrapedCompany(scraperData);
                            cache[currentSearch].scraped = scraperData;

                            if (scraperData.potentialParentWebsites && scraperData.potentialParentWebsites.length > 0) {
                                const parents = scraperData.potentialParentWebsites;
                                console.log(`Fallback: Found ${parents.length} potential parent companies:`, parents);

                                for (const parent of parents) {
                                    // Ensure we still care about this search
                                    if (activeSearchDomain.current !== domain && !parents.includes(activeSearchDomain.current)) break;
                                    if (parent.toLowerCase() === domain.toLowerCase()) continue;

                                    console.log(`Searching contacts for parent: ${parent}...`);
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
                                            console.log(`✓ Found ${parentLushaResults.contacts.length} contacts for parent: ${parent}`);
                                            if (activeSearchDomain.current === parent) {
                                                setLushaData(parentLushaResults);
                                                cache[currentSearch].lusha = parentLushaResults;
                                                scraperData.parentWebsite = parent;
                                                setScrapedCompany(scraperData);
                                                break;
                                            }
                                        }
                                    } catch (e) { console.warn(`Parent search failed:`, e); }
                                }
                            }

                            // Final Fallback: If still no contacts, and we have a parent name, try searching by name
                            const currentLushaData = cache[currentSearch].lusha;
                            if ((!currentLushaData || !currentLushaData.contacts || currentLushaData.contacts.length === 0) && scraperData.name) {
                                console.log(`Attempting final Name Search fallback for: ${scraperData.name}...`);
                                setRedirectingParent(`Name: ${scraperData.name}`);
                                setLushaLoading(true);

                                try {
                                    const nameResults = await searchDecisionMakers(null, {
                                        isParent: true,
                                        companyName: scraperData.name
                                    });

                                    if (nameResults && nameResults.contacts && nameResults.contacts.length > 0) {
                                        console.log(`✓ Success via Name Search: Found ${nameResults.contacts.length} contacts.`);
                                        if (activeSearchDomain.current === domain || scraperData.potentialParentWebsites?.includes(activeSearchDomain.current)) {
                                            setLushaData(nameResults);
                                            cache[currentSearch].lusha = nameResults;
                                            setScrapedCompany(scraperData);
                                        }
                                    }
                                } catch (e) {
                                    console.warn("Name search fallback failed:", e);
                                }
                            }
                        }
                    } catch (scraperErr) {
                        console.error("Total scraper failure:", scraperErr);
                    } finally {
                        setScrapedLoading(false);
                        setRedirectingParent(null);
                        setRetryingStatus(null);
                        setLushaLoading(false); // Ensure this is cleared
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
                }
            })
            .finally(() => {
                // We clear loading states if the search is still considered "active" 
                // (either matched the original domain or one of its parents)
                const isRelevant = activeSearchDomain.current === domain ||
                    (cache[currentSearch]?.scraped?.potentialParentWebsites?.includes(activeSearchDomain.current));

                if (isRelevant) {
                    setLushaLoading(false);
                    setLoading(false);
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

                                    {/* Hero stats row */}
                                    <div className="p-6">
                                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
                                            {/* Left: Visits + Page Views */}
                                            <div className="flex gap-8">
                                                <div>
                                                    <div className="flex items-center gap-1 mb-1">
                                                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Monthly Visits</p>
                                                        <span title="Sessions: counted each time a user lands on the site until they leave. Source: Zylalabs." className="cursor-help text-slate-600 hover:text-slate-400 transition-colors">
                                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                        </span>
                                                    </div>
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
                                                    <div className="flex items-center gap-1 mb-1">
                                                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Page Views</p>
                                                        <span title="Total pages loaded = Visits × Pages per Visit. Source: Zylalabs." className="cursor-help text-slate-600 hover:text-slate-400 transition-colors">
                                                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                                        </span>
                                                    </div>
                                                    <p className="text-5xl font-black text-cyan-400 tracking-tight">
                                                        {(() => {
                                                            const visits = data.Engagments?.Visits ? parseInt(data.Engagments.Visits, 10) : (data.EstimatedMonthlyVisits ? Object.values(data.EstimatedMonthlyVisits).pop() : null);
                                                            const ppv = data.Engagments?.PagePerVisit ? parseFloat(data.Engagments.PagePerVisit) : 1.5; // Default 1.5 multiplier if PPV missing
                                                            if (visits) return formatNumber(Math.round(visits * ppv));
                                                            return '—';
                                                        })()}
                                                    </p>
                                                    <p className="text-xs text-slate-500 mt-1 font-medium">total page views</p>
                                                </div>
                                            </div>

                                            {/* Rank pills */}
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

                                    {/* Monthly breakdown toggle */}
                                    {data.EstimatedMonthlyVisits && (
                                        <div className="mt-6 border-t border-slate-700/30 pt-4">
                                            <div className="flex justify-between items-center mb-4">
                                                <button
                                                    onClick={() => setShowMonthlyVisits(v => !v)}
                                                    className="flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-cyan-400 transition-colors group"
                                                >
                                                    <svg
                                                        className={`w-4 h-4 transition-transform duration-300 ${showMonthlyVisits ? 'rotate-90' : ''}`}
                                                        fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                                    >
                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                    </svg>
                                                    {showMonthlyVisits ? 'Hide' : 'Show'} Historical Traffic
                                                </button>
                                                {showMonthlyVisits && (
                                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest bg-slate-900/50 px-2 py-1 rounded">
                                                        Latest 3 Months as of {new Date().toLocaleDateString(undefined, { month: 'short' })}
                                                    </span>
                                                )}
                                            </div>

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
                                                                    <tr key={date} className="hover:bg-slate-700/20 transition-colors group">
                                                                        <td className="px-4 py-3 text-slate-300 text-sm font-semibold group-hover:text-white transition-colors">{formatDate(date)}</td>
                                                                        <td className="px-4 py-3 text-right text-slate-300 group-hover:text-cyan-400 transition-colors font-mono text-sm font-bold">
                                                                            {formatNumber(visits)}
                                                                            <span className="text-slate-600 text-[10px] ml-1.5 font-normal">visits</span>
                                                                        </td>
                                                                    </tr>
                                                                ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div className="px-6 py-3 bg-slate-900/50 text-center text-xs text-slate-500 border-t border-slate-700/50">
                                    Data provided by Zylalabs
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
                                        <div className="flex items-center gap-3">
                                            <span className="text-xs font-mono text-indigo-400 bg-indigo-400/10 px-2 py-1 rounded border border-indigo-400/20">
                                                {showAllTech ? 'ALL' : 'TOP'} CATEGORIES
                                            </span>
                                            <button
                                                onClick={() => setShowAllTech(!showAllTech)}
                                                className="text-xs font-semibold text-slate-300 hover:text-white transition-colors bg-slate-700 hover:bg-slate-600 px-3 py-1 rounded-md border border-slate-600"
                                            >
                                                {showAllTech ? 'Show Less' : 'Show All'}
                                            </button>
                                        </div>
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
                                                            <span key={i} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 opacity-0 animate-fade-in relative group/tech" style={{ animationDelay: `${i * 50}ms`, animationFillMode: 'forwards' }} title={tech.Description}>
                                                                {tech.Name}
                                                                {tech.isRecent && (
                                                                    <span className="ml-1.5 flex h-2 w-2">
                                                                        <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-cyan-400 opacity-75"></span>
                                                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
                                                                    </span>
                                                                )}
                                                                {tech.isRecent && (
                                                                    <span className="absolute -top-6 left-1/2 -translate-x-1/2 bg-cyan-500 text-[10px] text-white px-1.5 py-0.5 rounded opacity-0 group-hover/tech:opacity-100 transition-opacity pointer-events-none font-bold uppercase tracking-tighter whitespace-nowrap shadow-lg">
                                                                        Recent
                                                                    </span>
                                                                )}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))}
                                        {!showAllTech && !Object.keys(techStack).some(k => ['cms', 'cdn', 'mobile', 'ads'].includes(k.toLowerCase())) && (
                                            <div className="col-span-full text-center text-slate-500 py-4 italic">
                                                No matching top categories detected. Click "Show All" to see other technologies.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {loading === false && data && !techStack && (
                            <div className="w-full mt-8 animate-slide-up animation-delay-200">
                                <div className="bg-slate-800/80 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden p-8 text-center text-slate-400">
                                    <svg className="mx-auto h-12 w-12 text-slate-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                    </svg>
                                    <p className="text-lg font-medium">No Technology Stack Detected</p>
                                    <p className="text-sm mt-1">BuiltWith could not find any technology profile for this domain.</p>
                                </div>
                            </div>
                        )}

                        {pageSpeedLoading && !pageSpeedMobile && !pageSpeedDesktop && (
                            <div className="w-full mt-8 bg-slate-800/50 backdrop-blur-md rounded-2xl border border-indigo-500/30 p-8 text-center animate-pulse">
                                <div className="flex flex-col items-center gap-4">
                                    <div className="relative">
                                        <div className="w-12 h-12 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin"></div>
                                        <div className="absolute inset-0 flex items-center justify-center">
                                            <div className="w-6 h-6 bg-indigo-500/20 rounded-full animate-ping"></div>
                                        </div>
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-white">Running Google PageSpeed Audit</h3>
                                        <p className="text-slate-400 text-sm mt-1">Analyzing both Mobile and Desktop performance (~1 min)...</p>
                                    </div>
                                </div>
                            </div>
                        )}

                        <PageSpeedResults mobileData={pageSpeedMobile} desktopData={pageSpeedDesktop} />

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
        </div >
    );
}

const PageSpeedResults = ({ mobileData, desktopData }) => {
    const [strategy, setStrategy] = useState('mobile');
    const data = strategy === 'mobile' ? mobileData : desktopData;

    if (!mobileData && !desktopData) return null;

    const experiences = data?.loadingExperience || data?.originLoadingExperience;
    const metrics = experiences?.metrics;

    // Performance score from Lighthouse (ranges from 0 to 1)
    const perfScore = data?.lighthouseResult?.categories?.performance?.score;
    // Real-user assessment status
    const assessmentStatus = experiences?.overall_category;

    // Derived status logic: prioritized field data, but respects the actual Lighthouse score
    const getOverallStatus = () => {
        // Only trust Field Data if it's FAST. If it's SLOW but Lighthouse is high, 
        // it often means the field data is old or for a different specific URL.
        if (assessmentStatus === 'FAST') return 'Passed';

        // Use Lighthouse score as secondary source of truth
        if (perfScore !== undefined && perfScore !== null) {
            if (perfScore >= 0.8) return 'Passed'; // 80%+ is a solid pass in this context
            if (perfScore >= 0.5) return 'Needs Improvement';
            return 'Failed';
        }

        if (assessmentStatus === 'SLOW') return 'Failed';
        if (assessmentStatus === 'AVERAGE') return 'Needs Improvement';

        return 'Analyzing...';
    };

    const overallStatus = getOverallStatus();
    const overallCategory = overallStatus === 'Passed' ? 'FAST' : (overallStatus === 'Failed' ? 'SLOW' : 'AVERAGE');

    // Core Web Vitals mapping
    const cwvis = [
        {
            id: 'LARGEST_CONTENTFUL_PAINT_MS',
            label: 'Largest Contentful Paint (LCP)',
            unit: 's',
            divisor: 1000,
            description: 'Good (≤ 2.5 s), Needs Improvement (2.5 s - 4 s), Poor (> 4 s)'
        },
        {
            id: 'INTERACTION_TO_NEXT_PAINT',
            label: 'Interaction to Next Paint (INP)',
            unit: 'ms',
            divisor: 1,
            description: 'Good (≤ 200 ms), Needs Improvement (200 ms - 500 ms), Poor (> 500 ms)'
        },
        {
            id: 'CUMULATIVE_LAYOUT_SHIFT_SCORE',
            label: 'Cumulative Layout Shift (CLS)',
            unit: '',
            divisor: 100, // CLS is returned as score * 100 in distributions but value is fractional
            description: 'Good (≤ 0.1), Needs Improvement (0.1 - 0.25), Poor (> 0.25)'
        }
    ];

    const notableMetrics = [
        { id: 'FIRST_CONTENTFUL_PAINT_MS', label: 'First Contentful Paint (FCP)', unit: 's', divisor: 1000 },
        { id: 'EXPERIMENTAL_TIME_TO_FIRST_BYTE', label: 'Time to First Byte (TTFB)', unit: 's', divisor: 1000 }
    ];

    const getStatusText = (cat) => cat === 'FAST' ? 'Passed' : (cat === 'SLOW' ? 'Failed' : 'Needs Improvement');
    const getStatusColor = (cat) => cat === 'FAST' ? 'text-emerald-400' : (cat === 'SLOW' ? 'text-red-400' : 'text-amber-400');
    const getIconColor = (cat) => cat === 'FAST' ? 'bg-emerald-400/20 text-emerald-400' : (cat === 'SLOW' ? 'bg-red-400/20 text-red-400' : 'bg-amber-400/20 text-amber-400');

    const MetricCard = ({ m, data }) => {
        if (!data) return (
            <div className="bg-slate-900/40 border border-slate-700/10 rounded-xl p-5 italic text-slate-500 text-[10px] flex flex-col items-center justify-center gap-2">
                <svg className="animate-spin h-3 w-3 text-slate-700" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>Loading field data...</span>
            </div>
        );
        const val = m.id === 'CUMULATIVE_LAYOUT_SHIFT_SCORE' ? (data.percentile / 100).toFixed(2) : (data.percentile / m.divisor).toFixed(m.divisor === 1 ? 0 : 1);
        const dists = data.distributions || [];

        return (
            <div className="bg-slate-900/40 border border-slate-700/30 rounded-xl p-5 hover:border-slate-600/50 transition-all group">
                <h4 className="text-xs font-bold text-slate-400 group-hover:text-slate-200 transition-colors mb-4">{m.label}</h4>
                <div className="flex items-baseline gap-1 mb-2">
                    <span className={`text-3xl font-black ${getStatusColor(data.category)}`}>{val}</span>
                    <span className="text-sm text-slate-500 font-bold">{m.unit}</span>
                </div>
                <div className="w-full h-1.5 flex rounded-full overflow-hidden bg-slate-800 mb-4">
                    {dists.map((d, i) => (
                        <div key={i} style={{ width: `${(d.proportion * 100).toFixed(1)}%` }} className={`${i === 0 ? 'bg-emerald-500' : (i === 1 ? 'bg-amber-500' : 'bg-red-500')}`} />
                    ))}
                </div>
                <div className="flex justify-between text-[10px] text-slate-500 font-medium">
                    <span>Good</span>
                    <span>Poor</span>
                </div>
                <div className="mt-4 pt-4 border-t border-slate-800/50 flex justify-between items-center text-[10px]">
                    <span className="text-slate-500 uppercase tracking-tighter font-bold">75th Percentile - {val}{m.unit}</span>
                    <span className={`px-2 py-0.5 rounded font-black ${getIconColor(data.category)} text-[8px]`}>{data.category}</span>
                </div>
            </div>
        );
    };

    return (
        <div className="w-full mt-8 animate-slide-up">
            <div className="bg-slate-800/80 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden">
                <div className="p-6 border-b border-slate-700/50 flex flex-col md:flex-row md:justify-between md:items-center gap-4 bg-gradient-to-r from-slate-800 to-slate-900">
                    <div className="flex items-center gap-4">
                        <div className={`p-3 rounded-full ${getIconColor(overallCategory)} ring-8 ring-slate-800`}>
                            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                            </svg>
                        </div>
                        <div>
                            <h2 className="text-xl font-black text-white leading-none flex items-center gap-2">
                                Core Web Vitals Assessment
                                {!data && (
                                    <span className="flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-indigo-400 opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                                    </span>
                                )}
                            </h2>
                            <p className={`text-sm font-bold mt-2 ${getStatusColor(overallCategory)} animate-pulse`}>
                                {data ? overallStatus : 'Running Lighthouse Audit... (~1 min)'}
                            </p>
                            {perfScore !== undefined && (
                                <p className="text-[10px] text-slate-500 mt-1 uppercase tracking-wider font-bold">
                                    Performance Score: <span className={getStatusColor(overallCategory)}>{Math.round(perfScore * 100)}%</span>
                                </p>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center bg-slate-900/60 p-1 rounded-lg border border-slate-700/50 shadow-inner">
                        <button
                            onClick={() => setStrategy('mobile')}
                            className={`px-4 py-1.5 rounded-md text-xs font-black transition-all duration-300 relative ${strategy === 'mobile' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                            MOBILE
                            {!mobileData && <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full animate-pulse shadow-[0_0_5px_rgba(245,158,11,0.5)]"></span>}
                        </button>
                        <button
                            onClick={() => setStrategy('desktop')}
                            className={`px-4 py-1.5 rounded-md text-xs font-black transition-all duration-300 relative ${strategy === 'desktop' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                        >
                            DESKTOP
                            {!desktopData && <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full animate-pulse shadow-[0_0_5px_rgba(245,158,11,0.5)]"></span>}
                        </button>
                    </div>
                </div>

                {!data ? (
                    <div className="p-16 text-center bg-slate-900/40 border-b border-slate-700/30">
                        <div className="relative w-16 h-16 mx-auto mb-6">
                            <div className="absolute inset-0 border-4 border-indigo-500/10 rounded-full"></div>
                            <div className="absolute inset-0 border-4 border-t-indigo-500 rounded-full animate-spin"></div>
                            <div className="absolute inset-0 flex items-center justify-center">
                                <span className="text-[10px] font-black text-indigo-400 animate-pulse">{strategy[0].toUpperCase()}</span>
                            </div>
                        </div>
                        <h3 className="text-white font-black uppercase tracking-[0.2em] text-sm">Building Strategy Profile</h3>
                        <p className="text-slate-500 text-[10px] font-bold mt-2 uppercase">Google PageSpeed Insight is performing a live audit for {strategy}</p>
                    </div>
                ) : (
                    <div className="p-6">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {cwvis.map(m => (
                                <MetricCard key={m.id} m={m} data={metrics?.[m.id]} />
                            ))}
                        </div>

                        <div className="mt-8">
                            <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-4 border-b border-slate-700/50 pb-2">Other Notable Metrics</h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {notableMetrics.map(m => (
                                    <div key={m.id} className="flex justify-between items-center p-4 bg-slate-900/40 rounded-xl border border-slate-700/20 group hover:border-slate-600/50 transition-all">
                                        <h4 className="text-xs font-bold text-slate-400 group-hover:text-slate-200 transition-colors uppercase tracking-tighter">{m.label}</h4>
                                        <div className="flex items-baseline gap-1">
                                            <span className={`text-xl font-black ${getStatusColor(metrics?.[m.id]?.category)}`}>
                                                {metrics?.[m.id] ? (metrics?.[m.id]?.percentile / m.divisor).toFixed(1) : '—'}
                                            </span>
                                            <span className="text-[10px] text-slate-500 font-bold uppercase">{m.unit}</span>
                                        </div>
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
