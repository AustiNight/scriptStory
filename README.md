<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/785a7d68-2839-48b6-b4b2-8558f5ecf242

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set provider keys in `.env.local` (for example `GEMINI_API_KEY`, optional `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
3. Run frontend + local API runtime together:
   `npm run dev`

The local API server binds to `127.0.0.1` by default and persists local single-user config/cache files under `.local-data/` (gitignored).

## Local verification

- Guardrails only: `npm run check:guardrails`
- Full local verification: `npm run verify`
