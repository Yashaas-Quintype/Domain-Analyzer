import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { 
    Users, 
    Globe, 
    Activity, 
    Zap, 
    ChevronDown, 
    ChevronUp, 
    Search,
    ExternalLink,
    Mail,
    Phone,
    Linkedin,
    Building2,
    Shield,
    Smartphone,
    Monitor,
    BarChart3,
    CheckCircle2,
    AlertCircle,
    Copy,
    Share2,
    Lock,
    Eye
} from 'lucide-react';

// Custom utility to handle retries with exponential backoff
const withRetry = async (fn, options = { maxRetries: 3, initialDelay: 1000 }) => {
    let lastError;
    for (let i = 0; i < options.maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (error.response?.status === 429) {
                const delay = options.initialDelay * Math.pow(2, i) + Math.random() * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
};

function App() {
    const [domain, setDomain] = useState('');
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState(null);
    const [scrapedCompany, setScrapedCompany] = useState(null);
    const [techStack, setTechStack] = useState(null);
    const [lushaData, setLushaData] = useState(null);
    const [lushaRequested, setLushaRequested] = useState(false);
    const [error, setError] = useState(null);
    const [searchHistory, setSearchHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [activeTab, setActiveTab] = useState('single');
    const [cache] = useState({});
    
    // PageSpeed Insight states
    const [pageSpeedMobile, setPageSpeedMobile] = useState(null);
    const [pageSpeedDesktop, setPageSpeedDesktop] = useState(null);
    const [pageSpeedLoading, setPageSpeedLoading] = useState(false);
    const [pageSpeedStarted, setPageSpeedStarted] = useState(false);
    const [trafficLoading, setTrafficLoading] = useState(false);
    const [techLoading, setTechLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [lushaLoading, setLushaLoading] = useState(false);

    // Ref to prevent race conditions on search
    const activeSearchDomain = useRef(null);

    // Initialize search history from localStorage
    useEffect(() => {
        const savedHistory = localStorage.getItem('searchHistory');
        if (savedHistory) {
            try {
                setSearchHistory(JSON.parse(savedHistory));
            } catch (e) {
                console.error("Failed to parse history", e);
            }
        }
    }, []);

    // Save history to localStorage
    useEffect(() => {
        localStorage.setItem('searchHistory', JSON.stringify(searchHistory));
    }, [searchHistory]);

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
        setSearchHistory(prev => {
            const filtered = prev.filter(d => d.toLowerCase().trim() !== cleanDomain);
            const updated = [newDomain, ...filtered].slice(0, 10);
            return updated;
        });
        setHistoryIndex(0);
    };

    const handleAnalyze = async (e) => {
        if (e) e.preventDefault();
        if (!domain) return;

        const cleanSearch = domain.toLowerCase().trim();
        const normalizedDomain = cleanSearch.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
        
        // Reset everything for new search
        setError(null);
        setData(null);
        setTechStack(null);
        setLushaData(null);
        setLushaRequested(false);
        setScrapedCompany(null);
        setPageSpeedMobile(null);
        setPageSpeedDesktop(null);
        
        activeSearchDomain.current = normalizedDomain;
        addToHistory(normalizedDomain);

        setLoading(true);
        setTrafficLoading(true);
        setTechLoading(true);
        setPageSpeedLoading(true);
        setPageSpeedStarted(true);
        
        // Parallel fetching for performance
        const fetchTraffic = async () => {
            try {
                const response = await withRetry(() => axios.get(`/api/zyla/api/29/site+traffic+api/93/traffic+source+and+overview`, {
                    params: { domain: normalizedDomain }
                }));
                const trafficData = response.data;
                setData(trafficData);
                if (cache[cleanSearch]) cache[cleanSearch].traffic = trafficData;
                return trafficData;
            } catch (err) {
                console.error("Traffic API failed:", err);
                return null;
            } finally {
                setTrafficLoading(false);
            }
        };

        const fetchTech = async () => {
            try {
                const response = await withRetry(() => axios.get(`/api/builtwith/v22/api.json`, {
                    params: { 
                        KEY: import.meta.env.VITE_BUILTWITH_KEY || 'ea894525-80c8-4320-b284-44f5eb507593',
                        LOOKUP: normalizedDomain 
                    }
                }));
                const techData = response.data.Results?.[0]?.Result?.Paths?.[0]?.Technologies || null;
                setTechStack(techData);
                if (cache[cleanSearch]) cache[cleanSearch].tech = techData;
                return techData;
            } catch (err) {
                console.error("BuiltWith API failed:", err);
                return null;
            } finally {
                setTechLoading(false);
            }
        };

        const fetchScrape = async () => {
            try {
                const response = await axios.get(`/api/scrape?domain=${normalizedDomain}`);
                setScrapedCompany(response.data);
                if (cache[cleanSearch]) cache[cleanSearch].scraped = response.data;
                return response.data;
            } catch (err) {
                console.error("Legal Scraper failed:", err);
                return null;
            }
        };

        const runPageSpeedAudit = async () => {
            const PSI_KEY = import.meta.env.VITE_PAGESPEED_KEY || '';
            const PSI_FIELDS = 'lighthouseResult/categories/performance/score,lighthouseResult/audits/first-contentful-paint,lighthouseResult/audits/largest-contentful-paint,lighthouseResult/audits/cumulative-layout-shift,lighthouseResult/audits/total-blocking-time,lighthouseResult/audits/speed-index';
            
            let psResolvedCount = 0;
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
                    return null;
                };

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

        // Initialize cache for this search
        cache[cleanSearch] = { traffic: null, tech: null, lusha: null, scraped: null };

        // Execute all fetches
        Promise.all([fetchTraffic(), fetchTech(), fetchScrape(), runPageSpeedAudit()])
            .finally(() => {
                setLoading(false);
            });
    };

    const handleRevealContacts = async () => {
        if (lushaRequested || lushaLoading) return;
        setLushaLoading(true);
        setLushaRequested(true);
        setError(null);

        try {
            const normalizedDomain = domain.toLowerCase().trim().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
            
            // Try to use the scraped company name or parent website first for more accurate results
            const searchCompany = scrapedCompany?.name || normalizedDomain;
            const searchWebsite = normalizedDomain;

            const response = await withRetry(() => axios.post('/api/lusha/v1/person/search', {
                filters: {
                    company_domain: [searchWebsite],
                    // Prioritize specific technical/management roles
                    job_title: ["Engineering", "Technology", "IT", "Technical", "Operations", "Managing Director", "VP", "Head of", "CTO", "CIO"]
                }
            }));

            // Filter out non-current and irrelevant roles (e.g. Sales) if needed
            const results = response.data?.data || [];
            const filteredResults = {
                ...response.data,
                data: results.filter(p => !p.job_title?.toLowerCase().includes('sales'))
            };

            setLushaData(filteredResults);
            
            const cleanSearch = domain.toLowerCase().trim();
            if (cache[cleanSearch]) cache[cleanSearch].lusha = filteredResults;

        } catch (err) {
            console.error("Lusha API Error:", err);
            setError(err.response?.status === 402 ? "Lusha Credit Limit Reached" : "Error retrieving contact details");
        } finally {
            setLushaLoading(false);
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

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="min-h-screen bg-[#0f172a] text-slate-100 font-sans selection:bg-indigo-500/30">
            {/* Elegant Background Pattern */}
            <div className="fixed inset-0 overflow-hidden pointer-events-none opacity-20 z-0">
                <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-indigo-600 rounded-full blur-[120px]"></div>
                <div className="absolute top-[20%] -right-[10%] w-[35%] h-[35%] bg-purple-600 rounded-full blur-[120px]"></div>
                <div className="absolute -bottom-[10%] left-[20%] w-[30%] h-[30%] bg-blue-600 rounded-full blur-[120px]"></div>
                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay"></div>
            </div>

            {/* Navigation / Control Bar */}
            <div className="relative z-10 w-full max-w-7xl mx-auto pt-8 px-6">
                <div className="flex flex-col md:flex-row items-center justify-center gap-4 mb-12">
                    <div className="bg-slate-800/50 backdrop-blur-xl p-1.5 rounded-2xl border border-slate-700/50 shadow-2xl flex gap-1">
                        <button 
                            onClick={() => setActiveTab('single')}
                            className={`px-8 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === 'single' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        >
                            Single Search
                        </button>
                        <button 
                            onClick={() => setActiveTab('bulk')}
                            className={`px-8 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === 'bulk' ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20' : 'text-slate-400 hover:text-white hover:bg-slate-700/50'}`}
                        >
                            Bulk Results
                        </button>
                    </div>

                    <button className="bg-slate-800/80 backdrop-blur-md p-3 rounded-full border border-slate-700/50 text-slate-400 hover:text-indigo-400 hover:border-indigo-500/30 transition-all ml-auto absolute right-6 top-8 md:static">
                        <Activity className="w-6 h-6" />
                    </button>
                </div>

                {activeTab === 'single' && (
                    <div className="max-w-4xl mx-auto">
                        {/* Search Main Container */}
                        <div className="relative group mb-16">
                            <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500/20 to-purple-500/20 rounded-[2.5rem] blur opacity-75 group-hover:opacity-100 transition duration-1000 group-hover:duration-200"></div>
                            <form onSubmit={handleAnalyze} className="relative flex items-center bg-slate-900/80 backdrop-blur-2xl rounded-[2rem] border border-slate-700/50 shadow-2xl p-3 overflow-hidden">
                                <div className="flex-1 flex items-center px-6 gap-4">
                                    <div className="flex gap-2">
                                        <button type="button" onClick={() => loadFromHistory(historyIndex + 1)} className="p-2 text-slate-500 hover:text-indigo-400 transition-colors">
                                            <ChevronUp className="w-5 h-5" />
                                        </button>
                                        <button type="button" onClick={() => loadFromHistory(historyIndex - 1)} className="p-2 text-slate-500 hover:text-indigo-400 transition-colors">
                                            <ChevronDown className="w-5 h-5" />
                                        </button>
                                    </div>
                                    <input 
                                        type="text" 
                                        value={domain}
                                        onChange={(e) => setDomain(e.target.value)}
                                        placeholder="e.g., google.com"
                                        className="w-full bg-transparent border-none outline-none text-xl font-medium placeholder:text-slate-600"
                                    />
                                </div>
                                <button 
                                    type="submit"
                                    disabled={loading}
                                    className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 text-white px-10 py-5 rounded-[1.5rem] font-bold text-lg shadow-xl shadow-indigo-600/20 transition-all flex items-center gap-3 active:scale-95"
                                >
                                    {loading ? (
                                        <div className="w-6 h-6 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
                                    ) : (
                                        <>Analyze</>
                                    )}
                                </button>
                            </form>
                        </div>

                        {/* Analysis Grid */}
                        {(data || trafficLoading) && (
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                                <StatCard 
                                    icon={<Users className="w-6 h-6 text-blue-400" />}
                                    title="Monthly Visits"
                                    value={trafficLoading ? "..." : (data?.Engagments?.Visits || data?.EstimatedMonthlyVisits || "N/A")}
                                    loading={trafficLoading}
                                />
                                <StatCard 
                                    icon={<Activity className="w-6 h-6 text-green-400" />}
                                    title="Bounce Rate"
                                    value={trafficLoading ? "..." : (data?.Engagments?.BounceRate ? `${(data.Engagments.BounceRate * 100).toFixed(1)}%` : "N/A")}
                                    loading={trafficLoading}
                                />
                                <StatCard 
                                    icon={<Globe className="w-6 h-6 text-purple-400" />}
                                    title="Top Country"
                                    value={trafficLoading ? "..." : (data?.TopCountryShares?.[0]?.CountryName || "N/A")}
                                    loading={trafficLoading}
                                />
                            </div>
                        )}

                        {/* Detailed Sections */}
                        {data && (data.Engagments?.Visits || data.EstimatedMonthlyVisits) && (
                            <div className="w-full space-y-8 animate-slide-up">
                                <div className="bg-slate-800/50 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden">
                                    <div className="px-8 py-6 border-b border-slate-700/50 flex items-center justify-between">
                                        <h2 className="text-xl font-bold flex items-center gap-3 text-white">
                                            <BarChart3 className="w-6 h-6 text-indigo-400" />
                                            Traffic Insights
                                        </h2>
                                        {data.Engagments?.Year && (
                                            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 bg-slate-900/50 px-3 py-1.5 rounded-full border border-slate-700/50">
                                                Active Since {data.Engagments.Year}
                                            </span>
                                        )}
                                    </div>
                                    <div className="p-8">
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                                            <MetricItem label="Avg. Visit Duration" value={data.Engagments.TimeOnSite ? `${Math.floor(data.Engagments.TimeOnSite / 60)}m ${data.Engagments.TimeOnSite % 60}s` : "N/A"} />
                                            <MetricItem label="Pages per Visit" value={data.Engagments.PageViews?.toFixed(2) || "N/A"} />
                                            <MetricItem label="Global Rank" value={data.GlobalRank || "N/A"} />
                                            <MetricItem label="Category Rank" value={data.CategoryRank || "N/A"} />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Tech Stack Component */}
                        {(techStack || techLoading) && (
                            <div className="w-full mt-8 animate-slide-up animation-delay-100">
                                <div className="bg-slate-800/50 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden">
                                    <div className="px-8 py-6 border-b border-slate-700/50 flex items-center justify-between bg-gradient-to-r from-slate-800/20 to-transparent">
                                        <h2 className="text-xl font-bold flex items-center gap-3 text-white">
                                            <Zap className="w-6 h-6 text-yellow-500" />
                                            Technology Stack
                                        </h2>
                                        <span className="text-xs font-bold text-slate-500 uppercase tracking-widest bg-slate-900/50 px-3 py-1 rounded-lg border border-slate-700/30">
                                            {techStack?.length || 0} Tools Detected
                                        </span>
                                    </div>
                                    <div className="p-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                                        {techLoading ? (
                                            Array(6).fill(0).map((_, i) => <div key={i} className="h-20 bg-slate-700/30 rounded-xl animate-pulse"></div>)
                                        ) : (
                                            techStack?.reduce((acc, tech) => {
                                                const cat = tech.Tag || 'Other';
                                                if (!acc[cat]) acc[cat] = [];
                                                acc[cat].push(tech);
                                                return acc;
                                            }, {}) && Object.entries(techStack.reduce((acc, tech) => {
                                                const cat = tech.Tag || 'Other';
                                                if (!acc[cat]) acc[cat] = [];
                                                acc[cat].push(tech);
                                                return acc;
                                            }, {})).map(([category, techs]) => (
                                                <div key={category} className="group flex flex-col p-5 bg-slate-900/40 rounded-2xl border border-slate-700/30 hover:border-indigo-500/30 transition-all hover:bg-slate-900/60 shadow-lg">
                                                    <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-3 opacity-80 group-hover:opacity-100">{category}</span>
                                                    <div className="flex flex-wrap gap-2">
                                                        {techs.slice(0, 5).map((t, idx) => (
                                                            <div key={idx} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/80 rounded-lg text-sm font-medium text-slate-300 border border-slate-700/50 group-hover:text-white group-hover:border-slate-600 transition-colors">
                                                                {t.Name}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))
                                        )}
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
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 11c0 3.517-1.009 6.799-2.753 9.571m-3.44-2.04l.054-.09A10.003 10.003 0 0012 21a10.003 10.003 0 008.381-4.562l.054.091c-1.744-2.772-2.753-6.054-2.753-9.571V7a1 1 0 00-1-1H7a1 1 0 00-1 1v3.857c0 3.421-1.348 6.524-3.545 8.785l-.014.014" />
                                        </svg>
                                    </div>
                                    <Building2 className="w-12 h-12 text-indigo-400 mx-auto mb-4" />
                                    <h3 className="text-lg font-bold text-white mb-2">Identify Key Decision Makers</h3>
                                    <p className="text-slate-400 text-sm mb-6 max-w-sm mx-auto">Connect with tech and management leaders through verified Lusha contact data.</p>
                                    <button 
                                        onClick={handleRevealContacts}
                                        className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-3 rounded-xl font-bold shadow-lg shadow-indigo-600/20 transition-all active:scale-95 flex items-center justify-center gap-2 mx-auto"
                                    >
                                        <Eye className="w-4 h-4" />
                                        Reveal Contacts
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Lusha Results */}
                        {(lushaData || lushaLoading) && (
                            <div className="w-full mt-8 animate-slide-up">
                                <div className="bg-slate-800/50 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden">
                                    <div className="px-8 py-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800 to-transparent flex items-center justify-between">
                                        <div>
                                            <h2 className="text-xl font-bold flex items-center gap-3 text-white">
                                                <Shield className="w-6 h-6 text-indigo-400" />
                                                Verified Decision Makers
                                            </h2>
                                            {scrapedCompany?.name && (
                                                <p className="text-indigo-400 text-sm font-semibold mt-1 flex items-center gap-2">
                                                    <CheckCircle2 className="w-3 h-3" />
                                                    Current Employees @ {scrapedCompany.name}
                                                </p>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-4">
                                            {lushaData?.data?.length > 0 && (
                                                <span className="bg-green-500/10 text-green-400 px-3 py-1 rounded-lg text-xs font-bold border border-green-500/20">
                                                    {lushaData.data.length} Results Found
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    
                                    <div className="p-8">
                                        {lushaLoading ? (
                                            <div className="space-y-4">
                                                {[1,2,3].map(i => <div key={i} className="h-24 bg-slate-700/30 rounded-xl animate-pulse"></div>)}
                                            </div>
                                        ) : lushaData?.data?.length > 0 ? (
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                {lushaData.data.map((contact, i) => (
                                                    <ContactCard key={i} contact={contact} />
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="text-center py-12">
                                                <AlertCircle className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                                                <p className="text-slate-400 font-medium">No verified technical contacts found.</p>
                                                <p className="text-xs text-slate-500 mt-2">Try searching the parent company or a different department.</p>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'bulk' && (
                    <div className="max-w-6xl mx-auto py-12 text-center">
                        <Lock className="w-16 h-16 text-slate-700 mx-auto mb-6" />
                        <h2 className="text-3xl font-black text-white mb-2">Bulk Analysis</h2>
                        <p className="text-slate-400 max-w-lg mx-auto mb-8">Process multiple domains simultaneously. Upload CSV or paste list of domains.</p>
                        <div className="bg-slate-800/30 p-12 rounded-[2rem] border-2 border-dashed border-slate-700/50">
                            <p className="text-slate-500 text-sm font-mono mt-8 italic">Bulk features coming soon...</p>
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="relative z-10 py-12 text-center text-slate-500 text-[10px] uppercase font-black tracking-widest bg-gradient-to-t from-slate-900/50 to-transparent mt-20">
                &copy; 2024 Domain Traffic Analyzer • High-Accuracy Competitive Intelligence
            </div>
            
            {/* Visual Effects */}
            <div className="fixed top-0 inset-x-0 h-40 bg-gradient-to-b from-[#0f172a] to-transparent pointer-events-none z-10"></div>
        </div>
    );
}

// Sub-components
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

    const performanceScore = data?.lighthouseResult?.categories?.performance?.score * 100;
    const coreWebVitals = data?.loadingExperience || data?.originLoadingExperience || {};
    const metrics = data?.lighthouseResult?.audits || {};

    const getScoreColor = (score) => {
        if (score >= 90) return 'text-green-500';
        if (score >= 50) return 'text-orange-500';
        return 'text-red-500';
    };

    const getScoreBg = (score) => {
        if (score >= 90) return 'bg-green-500/10';
        if (score >= 50) return 'bg-orange-500/10';
        return 'bg-red-500/10';
    };

    const getStatusLabel = (category) => {
        if (category === 'FAST') return <span className="text-green-500 font-bold">Fast</span>;
        if (category === 'AVERAGE') return <span className="text-orange-500 font-bold">Average</span>;
        return <span className="text-red-500 font-bold">Slow</span>;
    };

    return (
        <div className="w-full mt-8 bg-slate-800/50 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden animate-slide-up">
            <div className="px-8 py-6 border-b border-slate-700/50 bg-gradient-to-r from-slate-800 to-transparent flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <Activity className="w-6 h-6 text-indigo-400" />
                    <h2 className="text-xl font-bold text-white">Google PageSpeed Insights</h2>
                </div>
                <div className="flex bg-slate-900/50 p-1 rounded-xl border border-slate-700/50">
                    <button 
                        onClick={() => setStrategy('mobile')}
                        className={`flex items-center gap-2 px-6 py-2 rounded-lg font-bold text-sm transition-all ${strategy === 'mobile' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}
                    >
                        <Smartphone className="w-4 h-4" />
                        Mobile
                    </button>
                    <button 
                        onClick={() => setStrategy('desktop')}
                        className={`flex items-center gap-2 px-6 py-2 rounded-lg font-bold text-sm transition-all ${strategy === 'desktop' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}
                    >
                        <Monitor className="w-4 h-4" />
                        Desktop
                    </button>
                </div>
            </div>

            <div className="p-8">
                {loading && (
                    <div className="flex items-center gap-3 mb-6 bg-indigo-600/10 border border-indigo-500/20 p-4 rounded-xl">
                        <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                        <p className="text-sm font-semibold text-indigo-300">Refreshing Strategy...</p>
                    </div>
                )}
                
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
                    {/* Main Performance Circle */}
                    <div className="lg:col-span-4 flex flex-col items-center justify-center p-8 bg-slate-900/40 rounded-3xl border border-slate-700/50 shadow-inner">
                        <div className={`relative w-48 h-48 rounded-full flex items-center justify-center border-8 ${getScoreColor(performanceScore).replace('text', 'border')} ${getScoreBg(performanceScore)}`}>
                            <div className="text-center">
                                <span className={`text-6xl font-black ${getScoreColor(performanceScore)}`}>
                                    {Math.round(performanceScore || 0)}
                                </span>
                                <div className="text-[10px] uppercase font-black tracking-widest text-slate-500 mt-1">Performance</div>
                            </div>
                        </div>
                        <div className="mt-8 grid grid-cols-3 gap-3 w-full">
                            <ScoreDot color="bg-red-500" range="0-49" />
                            <ScoreDot color="bg-orange-500" range="50-89" />
                            <ScoreDot color="bg-green-500" range="90-100" />
                        </div>
                    </div>

                    {/* Core Web Vitals & Real-user data */}
                    <div className="lg:col-span-8 space-y-8">
                        <div>
                            <div className="flex items-center gap-2 mb-4">
                                <h3 className="text-lg font-black text-white uppercase tracking-wider">Core Web Vitals Assessment</h3>
                                {data?.loadingExperience?.overall_category && (
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest ${data.loadingExperience.overall_category === 'FAST' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                                        {data.loadingExperience.overall_category === 'FAST' ? 'Passed' : 'Failed'}
                                    </span>
                                )}
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <PerformanceMetricCard 
                                    name="Largest Contentful Paint (LCP)" 
                                    value={coreWebVitals.metrics?.LARGEST_CONTENTFUL_PAINT_MS?.percentile ? `${(coreWebVitals.metrics.LARGEST_CONTENTFUL_PAINT_MS.percentile / 1000).toFixed(1)}s` : metrics['largest-contentful-paint']?.displayValue || 'N/A'}
                                    category={coreWebVitals.metrics?.LARGEST_CONTENTFUL_PAINT_MS?.category}
                                />
                                <PerformanceMetricCard 
                                    name="Interaction to Next Paint (INP)" 
                                    value={coreWebVitals.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile ? `${coreWebVitals.metrics.INTERACTION_TO_NEXT_PAINT.percentile}ms` : 'N/A'}
                                    category={coreWebVitals.metrics?.INTERACTION_TO_NEXT_PAINT?.category}
                                />
                                <PerformanceMetricCard 
                                    name="Cumulative Layout Shift (CLS)" 
                                    value={coreWebVitals.metrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile ? (coreWebVitals.metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100).toFixed(2) : metrics['cumulative-layout-shift']?.displayValue || 'N/A'}
                                    category={coreWebVitals.metrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE?.category}
                                />
                                <PerformanceMetricCard 
                                    name="First Contentful Paint (FCP)" 
                                    value={coreWebVitals.metrics?.FIRST_CONTENTFUL_PAINT_MS?.percentile ? `${(coreWebVitals.metrics.FIRST_CONTENTFUL_PAINT_MS.percentile / 1000).toFixed(1)}s` : metrics['first-contentful-paint']?.displayValue || 'N/A'}
                                    category={coreWebVitals.metrics?.FIRST_CONTENTFUL_PAINT_MS?.category}
                                />
                            </div>
                        </div>

                        <div className="pt-6 border-t border-slate-700/50">
                            <div className="flex items-center justify-between mb-2">
                                <p className="text-xs text-slate-500 uppercase font-black tracking-widest">About this audit</p>
                                <button onClick={onRetry} className="text-[10px] font-bold text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
                                    <Activity className="w-3 h-3" /> Force Refresh Result
                                </button>
                            </div>
                            <p className="text-xs text-slate-500 leading-relaxed">
                                Values are captured from the Google PageSpeed V5 API using actual Chrome user data (CrUX) where available and simulated Lighthouse lab results.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function ScoreDot({ color, range }) {
    return (
        <div className="flex flex-col items-center gap-1">
            <div className={`w-3 h-3 rounded-full ${color}`}></div>
            <span className="text-[10px] font-bold text-slate-500">{range}</span>
        </div>
    );
}

function PerformanceMetricCard({ name, value, category }) {
    const getBadgeStyle = (cat) => {
        if (cat === 'FAST') return 'bg-green-500/20 text-green-400';
        if (cat === 'AVERAGE') return 'bg-orange-500/20 text-orange-400';
        return 'bg-red-500/20 text-red-400';
    };

    return (
        <div className="bg-slate-900/60 p-5 rounded-2xl border border-slate-700/40 hover:border-slate-600 transition-all group">
            <div className="flex justify-between items-start mb-2">
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest group-hover:text-slate-400">{name}</span>
                {category && <span className={`text-[8px] px-2 py-0.5 rounded font-black uppercase tracking-widest ${getBadgeStyle(category)}`}>{category}</span>}
            </div>
            <div className="text-2xl font-black text-white">{value}</div>
        </div>
    );
}

function StatCard({ icon, title, value, loading }) {
    return (
        <div className="bg-slate-800/50 backdrop-blur-md p-8 rounded-3xl border border-slate-700/50 hover:bg-slate-800/80 transition-all duration-300 shadow-2xl group">
            <div className="flex items-center gap-4 mb-4">
                <div className="p-3 bg-slate-900/50 rounded-2xl border border-slate-700 group-hover:border-indigo-500/30 transition-colors">
                    {icon}
                </div>
                <h3 className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">{title}</h3>
            </div>
            <div className={`text-3xl font-black truncate tracking-tight ${loading ? 'opacity-20' : 'text-white'}`}>
                {value}
            </div>
        </div>
    );
}

function MetricItem({ label, value }) {
    return (
        <div className="flex flex-col group">
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 group-hover:text-indigo-400 transition-colors">{label}</span>
            <span className="text-xl font-bold text-white tracking-tight">{value}</span>
        </div>
    );
}

function ContactCard({ contact }) {
    return (
        <div className="p-6 bg-slate-900/40 rounded-2xl border border-slate-700/30 hover:border-indigo-500/30 transition-all group relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-0 group-hover:opacity-100 transition-opacity">
                <Linkedin className="w-5 h-5 text-indigo-400 hover:text-indigo-300 cursor-pointer" />
            </div>
            
            <div className="flex items-start gap-5">
                <div className="w-14 h-14 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl flex items-center justify-center text-white font-black text-xl shadow-lg group-hover:scale-110 transition-transform">
                    {contact.first_name?.[0]}{contact.last_name?.[0]}
                </div>
                <div>
                    <h4 className="font-bold text-lg text-white group-hover:text-indigo-300 transition-colors">{contact.first_name} {contact.last_name}</h4>
                    <p className="text-slate-400 text-sm font-medium mb-4">{contact.job_title}</p>
                    
                    <div className="space-y-2.5">
                        {contact.emails?.[0] && (
                            <div className="flex items-center gap-3 text-sm text-slate-400 hover:text-white transition-colors cursor-pointer group/item">
                                <div className="p-1.5 bg-slate-800 rounded-lg border border-slate-700 group-hover/item:border-indigo-500/30">
                                    <Mail className="w-3.5 h-3.5" />
                                </div>
                                <span>{contact.emails[0]}</span>
                            </div>
                        )}
                        {contact.phones?.[0] && (
                            <div className="flex items-center gap-3 text-sm text-slate-400">
                                <div className="p-1.5 bg-slate-800 rounded-lg border border-slate-700">
                                    <Phone className="w-3.5 h-3.5" />
                                </div>
                                <span>{contact.phones[0]}</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default App;
