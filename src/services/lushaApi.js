import axios from 'axios';
import { withRetry } from '../utils/apiRetry.js';

const LUSHA_API_KEY = (import.meta.env?.VITE_LUSHA_API_KEY) || '34aa0ade-c0d6-4e22-b391-dc281d12d2e1';

const cleanDomainForSearch = (domain) => {
    if (!domain) return '';
    let cleaned = domain.toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?/, '')
        .replace(/\/(.*)$/, '')
        .trim();

    const variant = cleaned.replace(/(limited|ltd|inc|corp|corporation|llc|plc|gmbh|limted)(\.[a-z]{2,}(\.[a-z]{2})?)$/i, '$2');

    return variant;
};

const cleanDomainForMatch = (domain) => {
    if (!domain) return { full: '', base: '' };
    let cleaned = domain.toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?/, '')
        .replace(/\/(.*)$/, '')
        .trim();

    const baseName = cleaned.replace(/\.[a-z]{2,}(\.[a-z]{2})?$/, '');

    return { full: cleaned, base: baseName };
};

export const searchDecisionMakers = async (domain, { onRetry = null, isParent = false, companyName = null } = {}) => {
    if (!LUSHA_API_KEY) {
        throw new Error("API Key is missing. Please check your .env file.");
    }

    const performSearch = async (targetDomain) => {
        try {
            console.log(`Step 1: Searching decision makers for domain: ${targetDomain}...`);
            const searchResponse = await withRetry(() => axios.post(
                '/api/lusha/prospecting/contact/search',
                {
                    filters: {
                        contacts: { include: { seniority: [10, 9, 8, 7, 6, 5] } },
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
                        contacts: { include: { seniority: [10, 9, 8, 7, 6, 5] } },
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

        if (searchContacts.length === 0 && domain.split('.').length > 2) {
            const root = domain.split('.').slice(-2).join('.');
            const rootResult = await performSearch(root);
            searchContacts = rootResult.searchContacts;
            requestId = rootResult.requestId || requestId;
        }

        const variant = cleanDomainForSearch(domain);
        const currentDomainOnly = domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');

        if (variant !== currentDomainOnly && variant.includes('.')) {
            if (isParent || searchContacts.length < 25) {
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
            return { contacts: [], requestId, companyInfo: { name: companyName || 'Unknown Company', domain: domain } };
        }

        // --- STRICT FILTERS (EXCLUDE HR, Marketing, Finance AND Sales) ---
        const EXCLUDED_DEPARTMENTS = [
            'human resources', 'hr', 'people operations', 'talent acquisition', 'recruiting', 'recruitment', 'people & culture',
            'marketing', 'brand', 'communications', 'public relations', 'pr', 'content', 'social media', 'growth marketing', 'demand generation',
            'finance', 'financial', 'accounting', 'financial planning', 'fp&a', 'treasury', 'accounts payable', 'accounts receivable', 'bookkeeping', 'audit', 'tax', 'controller', 'revenue operations', 'billing', 'payroll',
            // --- SALES EXCLUSIONS ---
            'sales', 'business development', 'account management', 'customer success', 'sales operations', 'retail', 'inside sales', 'outside sales', 'lead generation'
        ];

        const EXCLUDED_TITLE_KEYWORDS = [
            'hr ', 'human resource', 'recruiter', 'talent', 'people ops', 'people partner', 'people & culture',
            'marketing', 'brand manager', 'social media', 'content manager', 'public relations', 'communications manager', 'growth hacker', 'demand gen', 'campaign manager',
            'finance', 'financial', 'accountant', 'accounting', 'treasurer', 'bookkeeper', 'auditor', 'tax manager', 'tax director', 'controller', 'cfo', 'chief financial', 'fp&a', 'revenue operations', 'billing manager', 'payroll', 'head of finance', 'vp finance', 'director of finance',
            // --- SALES TITLE EXCLUSIONS ---
            'sales', 'account executive', 'account manager', 'business development', 'biz dev', 'customer success', 'customer experience', 'retail', 'sales associate', 'growth manager', 'partnership manager', 'leads'
        ];

        // --- ALLOWED DEPARTMENTS (STRICT INCLUSION) ---
        const ALLOWED_KEYWORDS = [
            'technical', 'information technology', 'it ', 'engineering', 'software', 'cto', 'developer',
            'product', 'infrastructure', 'security', 'data', 'analytics', 'systems', 'management', 'managing director', 'founder', 'ceo', 'coo', 'vp engineer'
        ];

        const isExcluded = (contact) => {
            const depts = (contact.departments || []).map(d => (typeof d === 'string' ? d : d?.name || '').toLowerCase());
            const title = (contact.jobTitle || '').toLowerCase();
            
            const deptMatch = depts.some(d => EXCLUDED_DEPARTMENTS.some(ex => d.includes(ex)));
            const titleMatch = EXCLUDED_TITLE_KEYWORDS.some(kw => title.includes(kw));

            // If it's excluded by keyword, drop it
            if (deptMatch || titleMatch) return true;

            // Strict check: Must have at least one allowed keyword or it is considered irrelevant
            const isAllowed = ALLOWED_KEYWORDS.some(kw => 
                title.includes(kw) || depts.some(d => d.includes(kw))
            );

            return !isAllowed; // Exclude if NOT allowed
        };

        const relevantContacts = searchContacts.filter(c => !isExcluded(c));
        const contactIds = relevantContacts.map(c => c.contactId || c.id || c.personId).filter(id => id);
        
        // LIMIT TO 15 CONTACTS
        const idsToEnrich = contactIds.slice(0, 15);

        const enrichResponse = await withRetry(() => axios.post(
            '/api/lusha/prospecting/contact/enrich',
            { requestId, contactIds: idsToEnrich },
            { headers: { 'api_key': LUSHA_API_KEY, 'Content-Type': 'application/json' } }
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
                // Secondary strict filter (Post-enrichment data)
                if (isExcluded(contact)) return false;

                const hasEmail = contact.emailAddresses && contact.emailAddresses.length > 0;
                const hasPhone = contact.phoneNumbers && contact.phoneNumbers.length > 0;
                const hasLinkedin = contact.socialLinks && contact.socialLinks.linkedin;
                if (!(hasEmail || hasPhone || hasLinkedin)) return false;

                if (isParent) return true;
                const contactDomainObj = cleanDomainForMatch(contact.company?.fqdn || contact.fqdn);
                const isFullMatch = contactDomainObj.full && (contactDomainObj.full.includes(targetSearch.full) || targetSearch.full.includes(contactDomainObj.full));
                const isBaseMatch = (contactDomainObj.base && targetSearch.base) && (contactDomainObj.base.includes(targetSearch.base) || targetSearch.base.includes(contactDomainObj.base));
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
                }), { initialDelay: 1500 });
                const personData = personResponse.data?.contact?.data;
                if (!personData || isParent) return contact;
                const currentCompany = personData.company;
                const currentDomainObj = cleanDomainForMatch(currentCompany?.fqdn || currentCompany?.domain);
                const isMatch = currentDomainObj.full && (currentDomainObj.full.includes(targetSearch.full) || targetSearch.full.includes(currentDomainObj.full)) || (currentDomainObj.base && currentDomainObj.base === targetSearch.base);
                if (!isMatch) contact.probableFormer = true;
                return contact;
            } catch (error) { return contact; }
        };

        const BATCH_SIZE = 2;
        const verifiedCurrentEmployees = [];
        for (let i = 0; i < finalContacts.length; i += BATCH_SIZE) {
            const batch = finalContacts.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(contact => verifyContact(contact)));
            batchResults.forEach(result => { if (result) verifiedCurrentEmployees.push(result); });
            if (i + BATCH_SIZE < finalContacts.length) await new Promise(r => setTimeout(r, 1000));
        }

        return { contacts: verifiedCurrentEmployees, requestId: enrichResponse.data.requestId || requestId, companyInfo };
    } catch (err) {
        throw new Error(err.message || 'Failed to fetch decision makers.');
    }
};
