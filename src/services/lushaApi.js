import axios from 'axios';
import { withRetry } from '../utils/apiRetry.js';

const LUSHA_API_KEY = (import.meta.env?.VITE_LUSHA_API_KEY) || '34aa0ade-c0d6-4e22-b391-dc281d12d2e1';

const cleanDomainForSearch = (domain) => {
    if (!domain) return '';
    let cleaned = domain.toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?/, '')
        .replace(/\/(.*)$/, '')
        .trim();

    // Remove common legal suffixes and the user's mentioned typo 'limted'
    const variant = cleaned.replace(/(limited|ltd|inc|corp|corporation|llc|plc|gmbh|limted)(\.[a-z]{2,}(\.[a-z]{2})?)$/i, '$2');

    return variant;
};

const cleanDomainForMatch = (domain) => {
    if (!domain) return { full: '', base: '' };
    let cleaned = domain.toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?/, '')
        .replace(/\/(.*)$/, '')
        .trim();

    // Remove common suffixes like .com, .net, .in etc to get the 'base'
    const baseName = cleaned.replace(/\.[a-z]{2,}(\.[a-z]{2})?$/, '');

    return { full: cleaned, base: baseName };
};

export const searchDecisionMakers = async (domain, { onRetry = null, isParent = false, companyName = null } = {}) => {
    if (!LUSHA_API_KEY) {
        throw new Error("API Key is missing. Please check your .env file.");
    }

    const performSearch = async (targetDomain) => {
        if (!targetDomain) return { searchContacts: [], requestId: null };
        try {
            console.log(`Step 1: Searching decision makers for domain: ${targetDomain}...`);
            const searchResponse = await withRetry(() => axios.post(
                '/api/lusha/prospecting/contact/search',
                {
                    filters: {
                        contacts: {
                            include: {
                                seniority: [10, 9, 8, 7, 6]
                            }
                        },
                        companies: { include: { domains: [targetDomain] } }
                    }
                },
                {
                    headers: { 'api_key': LUSHA_API_KEY, 'Content-Type': 'application/json' }
                }
            ), {
                initialDelay: 2000,
                onRetry: (count, delay) => onRetry?.(`Lusha Search (${count}/5)`, delay)
            });

            return {
                searchContacts: searchResponse.data.data || searchResponse.data.contacts || [],
                requestId: searchResponse.data.requestId
            };
        } catch (err) {
            console.warn(`Search failed for ${targetDomain}:`, err.message);
            return { searchContacts: [], requestId: null };
        }
    };

    const performNameSearch = async (name) => {
        if (!name || name.length < 3) return { searchContacts: [], requestId: null };
        try {
            console.log(`Step 1B: Searching decision makers by Name: ${name}...`);
            const searchResponse = await withRetry(() => axios.post(
                '/api/lusha/prospecting/contact/search',
                {
                    filters: {
                        contacts: {
                            include: {
                                seniority: [10, 9, 8, 7, 6]
                            }
                        },
                        companies: { include: { name: [name] } }
                    }
                },
                {
                    headers: { 'api_key': LUSHA_API_KEY, 'Content-Type': 'application/json' }
                }
            ), {
                initialDelay: 2000,
                onRetry: (count, delay) => onRetry?.(`Lusha Name Search (${count}/5)`, delay)
            });

            return {
                searchContacts: searchResponse.data.data || searchResponse.data.contacts || [],
                requestId: searchResponse.data.requestId
            };
        } catch (err) {
            console.warn(`Name search failed for ${name}:`, err.message);
            return { searchContacts: [], requestId: null };
        }
    };

    try {
        let { searchContacts, requestId } = await performSearch(domain);

        // Fallback 1: Root domain if subdomain search yielded nothing
        if (searchContacts.length === 0 && domain && domain.split('.').length > 2) {
            const root = domain.split('.').slice(-2).join('.');
            console.log(`No contacts for ${domain}, checking root: ${root}`);
            const rootResult = await performSearch(root);
            searchContacts = rootResult.searchContacts;
            requestId = rootResult.requestId || requestId;
        }

        // Fallback 2: Cleaned domain variant (removes 'limited', etc.)
        const variant = cleanDomainForSearch(domain);
        const currentDomainOnly = domain ? domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '') : '';

        if (variant && variant !== currentDomainOnly && variant.includes('.')) {
            if (isParent || searchContacts.length < 25) {
                console.log(`Checking cleaned domain variant: ${variant}`);
                const variantResult = await performSearch(variant);

                if (variantResult.searchContacts.length > 0) {
                    const existingIds = new Set(searchContacts.map(c => c.contactId || c.id || c.personId));
                    const newContacts = variantResult.searchContacts.filter(c => !existingIds.has(c.contactId || c.id || c.personId));
                    searchContacts = [...searchContacts, ...newContacts];
                    requestId = requestId || variantResult.requestId;
                }
            }
        }

        if (searchContacts.length === 0 && companyName) {
            const nameResult = await performNameSearch(companyName);
            searchContacts = nameResult.searchContacts;
            requestId = nameResult.requestId || requestId;
        }

        if (searchContacts.length === 0) {
            return {
                contacts: [],
                requestId,
                companyInfo: { name: companyName || 'Unknown Company', domain: domain }
            };
        }

        // Exclusions
        const EXCLUDED_DEPARTMENTS = [
            'human resources', 'hr', 'people operations', 'talent acquisition',
            'recruiting', 'recruitment', 'people & culture', 'people and culture',
            'marketing', 'brand', 'communications', 'public relations', 'pr',
            'content', 'social media', 'growth marketing', 'demand generation',
            'finance', 'financial', 'accounting', 'financial planning', 'fp&a',
            'treasury', 'accounts payable', 'accounts receivable', 'bookkeeping',
            'audit', 'tax', 'controller', 'revenue operations', 'billing', 'payroll',
            'sales', 'business development', 'account management'
        ];

        const EXCLUDED_TITLE_KEYWORDS = [
            'hr ', 'chief hr', 'human resource', 'recruiter', 'talent', 'people ops',
            'people partner', 'people & culture',
            'marketing', 'brand manager', 'social media', 'content manager',
            'public relations', 'communications manager', 'growth hacker', 'demand gen',
            'finance', 'financial', 'accountant', 'accounting', 'treasurer', 'bookkeeper',
            'auditor', 'tax manager', 'tax director', 'controller', 'cfo', 'chief financial',
            'fp&a', 'revenue operations', 'billing manager', 'payroll', 'accounts payable',
            'accounts receivable', 'head of finance', 'vp finance', 'director of finance',
            'sales', 'account manager', 'business development', 'account executive'
        ];

        const isExcluded = (contact) => {
            const depts = (contact.departments || []).map(d => (typeof d === 'string' ? d : d?.name || '').toLowerCase());
            const title = (contact.jobTitle || '').toLowerCase();
            const deptMatch = depts.some(d => EXCLUDED_DEPARTMENTS.some(ex => d.includes(ex)));
            const titleMatch = EXCLUDED_TITLE_KEYWORDS.some(kw => title.includes(kw));
            return deptMatch || titleMatch;
        };

        const isRelevantRole = (contact) => {
            const title = (contact.jobTitle || '').toLowerCase();
            const depts = (contact.departments || []).map(d => (typeof d === 'string' ? d : d?.name || '').toLowerCase());

            // 1. Editorial Roles (Must be senior/ranking)
            const isEditor = title.includes('editor') || depts.some(d => d.includes('editor'));
            if (isEditor) {
                const seniorKeywords = ['senior', 'chief', 'executive', 'managing', 'head', 'director', 'vp', 'lead', 'principal', 'founder'];
                return seniorKeywords.some(kw => title.includes(kw));
            }

            // 2. Technical, IT, Engineering & General Management
            const isTech = ['tech', 'it ', 'information technology', 'engineering', 'product', 'software', 'cto', 'information security', 'infrastructure'].some(kw => title.includes(kw) || depts.some(d => d.includes(kw)));
            const isManagement = ['ceo', 'founder', 'owner', 'president', 'managing director', 'general manager', 'operations', 'md'].some(kw => title.includes(kw) || depts.some(d => d.includes(kw)));

            return isTech || isManagement;
        };

        const relevantContacts = searchContacts.filter(c => !isExcluded(c) && isRelevantRole(c));
        const contactIds = relevantContacts.map(c => c.contactId || c.id || c.personId).filter(id => id);

        const idsToEnrich = contactIds.slice(0, 15);
        const enrichResponse = await withRetry(() => axios.post(
            '/api/lusha/prospecting/contact/enrich',
            {
                requestId: requestId,
                contactIds: idsToEnrich
            },
            {
                headers: {
                    'api_key': LUSHA_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        ), {
            initialDelay: 2000,
            onRetry: (count, delay) => onRetry?.(`Lusha Enrich (${count}/5)`, delay)
        });

        const enrichedContactsRaw = enrichResponse.data.contacts || [];
        const targetSearch = cleanDomainForMatch(domain);

        const finalContacts = enrichedContactsRaw
            .filter(item => item.isSuccess && item.data)
            .map(item => item.data)
            .filter(contact => {
                if (isExcluded(contact) || !isRelevantRole(contact)) return false;
                const hasEmail = contact.emailAddresses && contact.emailAddresses.length > 0;
                const hasPhone = contact.phoneNumbers && contact.phoneNumbers.length > 0;
                const hasLinkedin = contact.socialLinks && contact.socialLinks.linkedin;
                if (!(hasEmail || hasPhone || hasLinkedin)) return false;
                if (isParent) return true;

                const contactDomainObj = cleanDomainForMatch(contact.company?.fqdn || contact.fqdn);
                const isFullMatch = contactDomainObj.full && (contactDomainObj.full.includes(targetSearch.full) || targetSearch.full.includes(contactDomainObj.full));
                const isBaseMatch = (contactDomainObj.base && targetSearch.base) &&
                    (contactDomainObj.base.includes(targetSearch.base) || targetSearch.base.includes(contactDomainObj.base));
                return isFullMatch || isBaseMatch;
            });

        let companyInfo = { name: 'Unknown Company', domain: domain };
        if (finalContacts.length > 0) {
            const first = finalContacts[0];
            if (first.companyName) companyInfo.name = first.companyName;
            const cDomain = first.company?.fqdn || first.fqdn;
            if (cDomain) companyInfo.domain = cDomain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
        }

        const verifyContact = async (contact) => {
            if (!contact.socialLinks || !contact.socialLinks.linkedin) return contact;
            try {
                const personResponse = await withRetry(() => axios.get('/api/lusha/v2/person', {
                    params: { linkedinUrl: contact.socialLinks.linkedin },
                    headers: { 'api_key': LUSHA_API_KEY }
                }), {
                    initialDelay: 1500,
                    onRetry: (count, delay) => onRetry?.(`Verify ${contact.fullName} (${count}/5)`, delay)
                });
                const personData = personResponse.data?.contact?.data;
                if (!personData || isParent) return contact;
                const currentDomainObj = cleanDomainForMatch(personData.company?.fqdn || personData.company?.domain);
                if (!(currentDomainObj.full && (currentDomainObj.full.includes(targetSearch.full) || targetSearch.full.includes(currentDomainObj.full)) ||
                    (currentDomainObj.base && currentDomainObj.base === targetSearch.base))) {
                    contact.probableFormer = true;
                }
                return contact;
            } catch (error) { return contact; }
        };

        const verifiedCurrentEmployees = [];
        for (let i = 0; i < finalContacts.length; i += 2) {
            const batch = finalContacts.slice(i, i + 2);
            const batchResults = await Promise.all(batch.map(contact => verifyContact(contact)));
            batchResults.forEach(result => { if (result) verifiedCurrentEmployees.push(result); });
            if (i + 2 < finalContacts.length) await new Promise(r => setTimeout(r, 1000));
        }

        return {
            contacts: verifiedCurrentEmployees,
            requestId: enrichResponse.data.requestId || requestId,
            companyInfo
        };

    } catch (err) {
        console.error("Lusha API Error:", err);
        throw new Error(err.message || 'Failed to fetch decision makers.');
    }
};
