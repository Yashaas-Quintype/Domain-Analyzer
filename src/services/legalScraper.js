// Helper to clean common footer junk from start of name
const cleanName = (name) => {
    const junkWords = ['Privacy', 'Policy', 'Terms', 'Conditions', 'Contact', 'About', 'Home', 'Menu', 'Copyright', 'All Rights Reserved', '©', 'Settings', 'Skip', 'Content'];
    let cleaned = name;
    let changed = true;
    while (changed) {
        changed = false;
        for (const word of junkWords) {
            if (cleaned.toLowerCase().startsWith(word.toLowerCase())) {
                cleaned = cleaned.substring(word.length).trim();
                changed = true;
            }
        }
    }
    if (cleaned.length < 3) return null;
    return cleaned;
}

// Helper to fetch and search a single URL
const checkUrl = async (url, baseUrl) => {
    try {
        console.log(`Scraping ${url} for legal entity name...`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

        const response = await fetch(url, {
            signal: controller.signal,
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        clearTimeout(timeoutId);
        if (!response.ok) return null;

        const html = await response.text();
        const baseUrlInternal = baseUrl.replace(/\/$/, '');

        // Discovery: Look for Privacy, About, Terms links if this is the base URL
        const newLinks = [];
        const normalizedUrl = url.replace(/\/$/, '');
        if (normalizedUrl === baseUrlInternal) {
            const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
            let match;
            while ((match = linkRegex.exec(html)) !== null) {
                const href = match[1];
                const text = (match[2] || '').toLowerCase();
                if (/privacy|about|terms|legal|contact/i.test(text) || /privacy|about|terms|legal|contact/i.test(href)) {
                    try {
                        const absoluteUrl = new URL(href, baseUrl).href;
                        const absoluteUrlNormalized = absoluteUrl.replace(/\/$/, '');
                        if (absoluteUrlNormalized.startsWith(baseUrlInternal) && absoluteUrlNormalized !== baseUrlInternal) {
                            newLinks.push(absoluteUrl);
                        }
                    } catch (e) { }
                }
            }
        }

        const cleanText = html
            .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
            .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Footer/Network Link Search
        const footerConfigs = [
            /(?:part of|powered by|a brand of|operated by|owned by|member of|published by|a property of|published in association with)\s*(?:the)?\s*(?:<[^>]+>)*\s*<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/i,
            /(?:visit|check out)\s*(?:our)?\s*(?:parent|corporate|network)\s*(?:site|company|portal)\s*(?:at)?\s*<a[^>]+href=["']([^"']+)["'][^>]*>/i,
            /(?:©|copyright)\s*(?:\d{4})?\s*(?:<[^>]+>)*\s*<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/i,
            /An?\s+<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>\s+(?:Brand|Site|Company|Network|Entity|Group|Media)/i,
            /(?:Property|Site|Project)\s+(?:of|by)\s+<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/i
        ];

        for (const regex of footerConfigs) {
            const match = html.match(regex);
            if (match) {
                const linkUrl = match[1];
                try {
                    const urlObj = new URL(linkUrl, url);
                    const distinctDomain = urlObj.hostname.replace(/^www\./, '');
                    const currentDomain = new URL(baseUrl).hostname.replace(/^www\./, '');

                    // Exclude common social media and tech providers from being 'parents'
                    const excludedParents = ['facebook.com', 'twitter.com', 'linkedin.com', 'instagram.com', 'youtube.com', 'wordpress.org', 'wordpress.com', 'wix.com', 'squarespace.com', 'google.com'];

                    if (distinctDomain !== currentDomain && distinctDomain.includes('.') && !excludedParents.includes(distinctDomain)) {
                        const name = match[2] ? cleanName(match[2].trim()) : null;
                        return { name: name, parentWebsite: distinctDomain, links: newLinks };
                    }
                } catch (e) { }
            }
        }

        // Broad footer link search: Look for links with "Network", "Group", "Media", "Holdings" in the text
        const networkLinkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*(?:Network|Group|Media|Holdings|Publishing|Properties)[^<]*)<\/a>/gi;
        let altMatch;
        while ((altMatch = networkLinkRegex.exec(html)) !== null) {
            const linkUrl = altMatch[1];
            const linkText = altMatch[2].trim();
            try {
                const urlObj = new URL(linkUrl, url);
                const distinctDomain = urlObj.hostname.replace(/^www\./, '');
                const currentDomain = new URL(baseUrl).hostname.replace(/^www\./, '');
                if (distinctDomain !== currentDomain && distinctDomain.includes('.') && linkText.length > 3) {
                    const name = cleanName(linkText);
                    return { name: name, parentWebsite: distinctDomain, links: newLinks };
                }
            } catch (e) { }
        }

        // Copyright Search
        const copyMatch = cleanText.match(/(?:copyright|©)\s*(?:\d{4}(?:\s*-\s*\d{4})?)?,?\s*([A-Z0-9][a-zA-Z0-9\s&,'.-]{3,60})/i);
        if (copyMatch) {
            let pName = copyMatch[1].trim().split(/[\.|\||–|-] /)[0].trim();
            if (!['all rights', 'reserved', 'design', 'powered by'].some(s => pName.toLowerCase().startsWith(s)) && /[A-Z]/.test(pName.charAt(0))) {
                pName = pName.replace(/[.,|:-]+$/, '').trim();
                if (!/^\d+$/.test(pName) && pName.length > 3) return { name: pName, parentWebsite: null, links: newLinks };
            }
        }

        // Suffix Search
        const suffixMatch = cleanText.match(/\b((?:[A-Z0-9][\w'&.-]*\s+){1,5})(Private Limited|Pvt Ltd|Ltd\.?|LLP|Inc\.?|Corporation|Corp\.?|Limited|GmbH|S\.A\.|S\.R\.L\.|PLC)\b/);
        if (suffixMatch) {
            const cName = cleanName(suffixMatch[1].trim());
            if (cName && (cName.match(/\d/g) || []).length <= cName.length * 0.4) {
                return { name: `${cName} ${suffixMatch[2]}`, parentWebsite: null, links: newLinks };
            }
        }

        return { name: null, parentWebsite: null, links: newLinks };
    } catch (e) {
        return { name: null, parentWebsite: null, links: [] };
    }
};

const commonAdNetworks = [
    'google.com', 'facebook.com', 'app-ads.txt', 'amazon-adsystem.com', 'amazon.com',
    'rubiconproject.com', 'pubmatic.com', 'openx.com', 'indexexchange.com', 'taboola.com',
    'outbrain.com', 'criteo.com', 'stnvideo.com', 'smartadserver.com', 'sovrn.com',
    'magnite.com', 'media.net', 'appnexus.com', 'improve.com', '33across.com',
    'conversantmedia.com', 'adtech.com', 'aolcloud.net', 'teads.tv', 'unruly.co',
    'yahoo.com', 'contextweb.com', 'triplelift.com', 'gumgum.com', 'sharethrough.com',
    'yieldmo.com', 'sonobi.com', 'connatix.com', 'primis.tech', 'liveintent.com',
    'nobid.io', 'spotxchange.com', 'sharethrough.com', 'adform.com', 'bidswitch.net',
    'adnxs.com', 'smartadserver.com', 'tapad.com', 'eyeota.com', 'lotame.com',
    'anymanager.io', 'yieldmonk.com', 'ezoic.com', 'snigel.com', 'mediavine.com',
    'adthrive.com', 'freestar.com', 'monetizemore.com', 'adpushup.com', 'vrtcal.com',
    'shemedia.com', 'playwire.com', 'cafemedia.com'
];

const knowledgeBase = {
    'footballinsider247.com': { name: 'Breaking Media Ltd', potentialParentWebsites: ['breakingmedialimited.com', 'breakingmedia.com', 'breakingmedialimted.com', 'grv.media'] },
    'footballinsider.co.uk': { name: 'Breaking Media Ltd', potentialParentWebsites: ['breakingmedialimited.com', 'breakingmedia.com', 'grv.media'] },
    'abovethelaw.com': { name: 'Breaking Media, Inc.', potentialParentWebsites: ['breakingmedia.com', 'breakingmedialimited.com'] },
    'fashionista.com': { name: 'The Arena Group', potentialParentWebsites: ['thearenagroup.net', 'arenagroup.com'] },
    'dealbreaker.com': { name: 'Breaking Media', potentialParentWebsites: ['breakingmedia.com'] },
    'medcitynews.com': { name: 'Breaking Media', potentialParentWebsites: ['breakingmedia.com'] },
    'breakingdefense.com': { name: 'Breaking Media', potentialParentWebsites: ['breakingmedia.com'] },
    'westhamzone.com': { name: 'Breaking Media Ltd', potentialParentWebsites: ['breakingmedialimited.com', 'breakingmedia.com'] }
};

export async function scrapeLegal(domain) {
    if (!domain) return null;
    const cleanInputDomain = domain.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');

    // Quick check for known domains
    if (knowledgeBase[cleanInputDomain]) {
        return {
            ...knowledgeBase[cleanInputDomain],
            adsTxtExists: true,
            parentWebsite: knowledgeBase[cleanInputDomain].potentialParentWebsites[0]
        };
    }

    const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
    const maxSubPages = 3;
    const result = {
        name: null,
        adsTxtExists: false,
        googlePublisherId: null,
        potentialParentWebsites: []
    };

    const addParent = (site) => {
        if (!site) return;
        const cleaned = site.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
        if (cleaned && cleaned !== cleanInputDomain && !result.potentialParentWebsites.includes(cleaned)) {
            result.potentialParentWebsites.push(cleaned);
        }
    };

    // 1️⃣ & 2️⃣ Fetch ads.txt and Homepage in parallel
    const [adsResult, homepageResult] = await Promise.all([
        (async () => {
            try {
                console.log(`Checking ${baseUrl}/ads.txt...`);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout
                const adsResponse = await fetch(`${baseUrl}/ads.txt`, {
                    signal: controller.signal,
                    method: 'GET'
                });
                clearTimeout(timeoutId);
                if (adsResponse.ok) {
                    const adsText = await adsResponse.text();
                    result.adsTxtExists = true;

                    const googleMatch = adsText.match(/pub-\d+/);
                    if (googleMatch) result.googlePublisherId = googleMatch[0];

                    const ownerMatch = adsText.match(/OwnerDomain\s*=\s*([a-zA-Z0-9.-]+\.[a-z]{2,})/i);
                    if (ownerMatch) addParent(ownerMatch[1]);

                    const managerMatch = adsText.match(/ManagerDomain\s*=\s*([a-zA-Z0-9.-]+\.[a-z]{2,})/i);
                    if (managerMatch) result.adsTxtManagerDomain = managerMatch[1].toLowerCase();
                }
            } catch (err) { /* ignore */ }
            return result;
        })(),
        checkUrl(baseUrl, baseUrl)
    ]);

    if (homepageResult) {
        if (homepageResult.name) result.name = homepageResult.name;
        if (homepageResult.parentWebsite) addParent(homepageResult.parentWebsite);

        // If we still need more info, check discovered pages
        if (homepageResult.links) {
            const extraPages = [...new Set(homepageResult.links)].slice(0, maxSubPages);
            for (const subUrl of extraPages) {
                const subResult = await checkUrl(subUrl, baseUrl);
                if (subResult) {
                    if (subResult.name && !result.name) result.name = subResult.name;
                    if (subResult.parentWebsite) addParent(subResult.parentWebsite);
                }
            }
        }
    }

    // Process the ManagerDomain from ads.txt if nothing better found
    const techProviderDomains = ['wordpress.org', 'wix.com', 'squarespace.com', 'bluehost.com', 'godaddy.com', 'automattic.com', 'wpengine.com', 'cloudflare.com'];
    if (result.adsTxtManagerDomain) {
        if (!techProviderDomains.includes(result.adsTxtManagerDomain) && !commonAdNetworks.includes(result.adsTxtManagerDomain)) {
            addParent(result.adsTxtManagerDomain);
        }
    }

    if (result.name || result.googlePublisherId || result.potentialParentWebsites.length > 0) {
        if (result.name) result.name = result.name.replace(/[.,|:-]+$/, '').trim();
        // Set the primary parent website if we found any
        if (result.potentialParentWebsites.length > 0) {
            result.parentWebsite = result.potentialParentWebsites[0];
        }
        return result;
    }

    return null;
}
