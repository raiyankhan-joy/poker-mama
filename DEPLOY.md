# POOKER — Online Production Deployment Guide

## 1. Deploy in 2 Minutes (Render.com / Railway / Fly.io)
1. Push this folder to a **GitHub** repository.
2. **Render.com**: Click **New → Blueprint** (it auto-detects `render.yaml` in Singapore region with `FORCE_HTTPS=true` and `/api/health`).
   - Or **Railway / Fly.io**: Connect the repo — it auto-detects `Dockerfile` or `npm start`.

## 2. Enable Permanent Cloud Leaderboard & XP (Free Upstash Redis)
1. Create a free Redis database at [upstash.com](https://upstash.com).
2. Copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** into your host's Environment Variables.
3. Verify at `https://your-domain/api/health` → `"persistenceMode": "upstash-redis"`.

*(Alternative: set `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` with a table `pooker_state(id text primary key, payload jsonb)`, or set `DATA_DIR=/var/data` on a mounted disk.)*

## 3. Enable 100% 4G/5G Voice Chat Reliability (Free TURN Server)
1. Create a free account at [metered.ca](https://www.metered.ca) → **TURN Server**.
2. Set `METERED_APP_NAME` and `METERED_API_KEY` (or `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`) in your host's Environment Variables.
3. Verify at `https://your-domain/api/health` → `"turnConfigured": true`.

## 4. Connect Your Custom Domain (with Free SSL)
1. In Render / Railway / Fly.io → **Settings → Custom Domains** → add `yourdomain.com`.
2. Add the shown `CNAME` / `A` record in your DNS provider (Cloudflare / Namecheap / GoDaddy).
3. SSL activates automatically and `FORCE_HTTPS=true` redirects all `http://` visitors to `https://` so Voice Chat microphone works everywhere.
