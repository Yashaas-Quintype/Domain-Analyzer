# Domain Analysis Tool - Production Ready

This folder contains the complete, updated source code for the Domain Analysis Tool, optimized for both local development and Vercel deployment.

## Key Features
- **PageSpeed Insights**: Robust retry mechanism with cache bypassing (`refresh=true`).
- **Traffic Analysis**: Real-time data from ZylaLabs with root domain fallback.
- **Tech Stack**: Integration with BuiltWith for infrastructure scanning.
- **Decision Makers**: Automated Lusha contact retrieval with parent company discovery.

## Deployment Instructions
1. **GitHub**: Push the contents of this folder to your repository.
2. **Vercel**: 
   - Ensure `VITE_PAGESPEED_KEY`, `VITE_ZYLALABS_KEY`, `VITE_BUILTWITH_KEY`, and `VITE_LUSHA_API_KEY` are set in Vercel environment variables.
   - The `api/proxy.js` will handle all serverless requests.

## Local Development
1. Run `npm install`
2. Run `npm run dev` for the frontend
3. Run `npm run server` for the local proxy (optional, frontend picks it up)
