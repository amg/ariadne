# Cloudflare Tunnel Deployment Guide

## Overview

Deploy the chat bot on a private server (home lab, VPS, or on-premise) and expose it securely via Cloudflare Tunnel **without opening firewall ports**.

**Architecture:** Combined deployment (frontend + backend + database on same server)

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Users     │────▶│  Cloudflare Edge │────▶│  Cloudflare     │────▶│  Private Server │
│  (Browser)  │     │   (Global CDN)   │     │  Tunnel         │     │  (All-in-One)   │
└─────────────┘     └──────────────────┘     └─────────────────┘     └─────────────────┘
                                                                              
                                                                              │
                                                                              ▼
                                                                    ┌─────────────────┐
                                                                    │  Docker Compose │
                                                                    │  - Frontend     │
                                                                    │  - Backend      │
                                                                    │  - PostgreSQL   │
                                                                    └─────────────────┘
```

## Why Combined Deployment?

| Factor | Combined ✅ | Split |
|--------|-------------|-------|
| **Deployment** | One command | Two pipelines |
| **CORS** | Not needed | Must configure |
| **Auth** | Simple cookies | Cross-domain complexity |
| **Debugging** | Single server | Distributed tracing |
| **Performance** | Localhost latency | Network calls |
| **Cost** | Free | Free (but more complex) |
| **Scaling** | Vertical (upgrade server) | Horizontal (add instances) |

**For personal/small-scale use: Combined is simpler and perfectly adequate.**

You can split frontend/backend later if you need global CDN or independent scaling.

---

## Prerequisites

- ✅ Private server always online (home server, VPS, etc.)
- ✅ Docker & Docker Compose installed
- ✅ Cloudflare account (free tier works)
- ✅ Domain managed by Cloudflare (or can transfer DNS)

---

## Step 1: Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env for your setup
PORT=3001                    # Backend port (internal)
HOST=0.0.0.0                 # Listen on all interfaces

# Database (internal Docker network)
DATABASE_URL=postgres://postgres:postgrespassword@db:5432/chatbot

# AI Provider (required for chat to work)
DEEPINFRA_API_KEY=your-api-key-here
DEFAULT_MODEL=Qwen/Qwen3.5-9B
```

---

## Step 2: Start Services

```bash
# Start all services
docker compose up -d

# Verify services are running
docker compose ps

# Check logs
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f db
```

Expected output:
```
NAME              STATUS
chat_db           Up (healthy)
chat_backend      Up
chat_frontend     Up
```

---

## Step 3: Install cloudflared

### Option A: Docker Compose (Recommended)

Add cloudflared service to `docker-compose.yml`:

```yaml
services:
  # ... existing services (db, backend, frontend)

  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared
    restart: unless-stopped
    command: tunnel run
    environment:
      - TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      - frontend
    networks:
      - chat-network
```

### Option B: Host Installation

**Ubuntu/Debian:**
```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
sudo systemctl daemon-reload
sudo systemctl enable cloudflared
```

---

## Step 4: Create Cloudflare Tunnel

### 1. Authenticate cloudflared

```bash
# Login to Cloudflare
cloudflared tunnel login

# This opens a browser window - login and select your domain
# Creates ~/.cloudflared/<TUNNEL_ID>.json
```

### 2. Create Tunnel

```bash
# Create named tunnel
cloudflared tunnel create chat-bot

# Output:
# Created tunnel chat-bot with id <TUNNEL_ID>
# Credentials written to ~/.cloudflared/<TUNNEL_ID>.json
```

### 3. Configure Tunnel

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: chat-bot
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json

ingress:
  # Route ALL traffic to frontend (which proxies to backend)
  - hostname: chat.yourdomain.com
    service: http://chat_frontend:80
  
  # Catch-all (deny everything else)
  - service: http_status:404
```

### 4. Get Tunnel Token

```bash
# Generate token for Docker deployment
cloudflared tunnel token --format json chat-bot > /path/to/chat-bot/token.json
```

### 5. Run Tunnel

**Docker Compose:**
```bash
# Copy token to .env
echo "CLOUDFLARE_TUNNEL_TOKEN=$(cat token.json)" >> .env

# Start cloudflared
docker compose up -d cloudflared
```

**Direct (host):**
```bash
sudo cloudflared tunnel run chat-bot
```

---

## Step 5: Configure DNS

Cloudflare Tunnel automatically creates DNS records, but verify:

1. Go to Cloudflare Dashboard → DNS
2. Ensure CNAME record exists:
   - **Name:** `chat` (or your subdomain)
   - **Content:** `<TUNNEL_ID>.cfargotunnel.com`
   - **Proxy status:** Proxied (orange cloud)

---

## Step 6: Configure SSL/TLS

Cloudflare Dashboard → SSL/TLS:

- **Encryption Mode:** Full (or Full (strict) if you add self-signed cert)
- **Always Use HTTPS:** Enabled
- **Minimum TLS Version:** 1.2
- **Opportunistic Encryption:** On

---

## Step 7: Test Deployment

```bash
# Test from outside your network
curl https://chat.yourdomain.com

# Test API endpoint
curl https://chat.yourdomain.com/api/health

# Test SSE streaming
curl -N https://chat.yourdomain.com/api/threads/test/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "test"}]}'
```

---

## Cloudflare-Specific Configuration

### SSE Over Cloudflare Tunnel

Cloudflare Tunnel supports SSE well:

| Setting | Default | Recommendation |
|---------|---------|----------------|
| **Idle Timeout** | 90 seconds | ✅ Sufficient for chat streams |
| **Max Duration** | No limit | ✅ Good for SSE |
| **WebSocket Support** | Yes | ✅ Also works if needed |

### Performance Settings

Cloudflare Dashboard → Speed → Optimization:

- **Auto Minify:** Enable for JS, CSS, HTML
- **Brotli:** Enabled
- **HTTP/2:** Enabled
- **HTTP/3 (QUIC):** Enabled (better for mobile)

### Caching Rules

Cloudflare Dashboard → Caching → Configuration:

```
# Cache static assets
Cache Level: Cache Everything
URL Prefix: https://chat.yourdomain.com/assets
Edge TTL: 1 month

# Don't cache API
Cache Level: Bypass
URL Prefix: https://chat.yourdomain.com/api
```

### Security Settings

Cloudflare Dashboard → Security:

- **Security Level:** Medium (adjust based on traffic)
- **Challenge TTL:** 15 minutes
- **Browser Integrity Check:** On
- **WAF Rules:** Enable OWASP Core Rule Set

### Access Control (Optional)

Cloudflare Dashboard → Access → Applications:

```yaml
# Add authentication before allowing access
Application:
  Name: Chat Bot
  Domain: chat.yourdomain.com
  Policy:
    - Email: your-email@example.com  # Allow specific users
```

---

## Monitoring & Alerts

### Cloudflare Dashboard

- **Analytics:** Traffic, bandwidth, threats
- **Tunnel Health:** Connection status, request counts
- **SSL/TLS:** Certificate status, encryption errors

### Local Monitoring

```bash
# Watch tunnel logs
docker compose logs -f cloudflared

# Monitor resource usage
docker stats

# Check service health
watch -n 5 'docker compose ps'
```

---

## Troubleshooting

### Tunnel Won't Connect

```bash
# Check token is valid
docker compose logs cloudflared | grep -i error

# Regenerate token if needed
cloudflared tunnel token chat-bot

# Restart tunnel
docker compose restart cloudflared
```

### SSE Connections Drop

```bash
# Check Cloudflare Tunnel logs
docker compose logs cloudflared | grep -i "idle\|timeout"

# Increase backend timeout
# Add to backend/.env:
AI_STREAM_IDLE_TIMEOUT_MS=30000  # 30 seconds (under 90s limit)
```

### 502 Bad Gateway

```bash
# Check if services are running
docker compose ps

# Check backend logs
docker compose logs backend

# Verify cloudflared can reach frontend
docker compose exec cloudflared curl http://chat_frontend:80
```

---

## Cost Breakdown

| Service | Tier | Cost |
|---------|------|------|
| **Cloudflare Tunnel** | Free | $0/month |
| **Cloudflare CDN** | Free | $0/month |
| **Cloudflare SSL** | Free | $0/month |
| **Server** | Home/VPS | $0-10/month |
| **Domain** | Annual | $10-15/year |

**Total: ~$1-2/month** (just domain amortized)

---

## Future: Split Deployment (Optional)

If you later need to split frontend/backend:

1. **Deploy frontend to Cloudflare Pages** (free CDN)
2. **Configure CORS** on backend
3. **Update tunnel** to route only API calls
4. **Coordinate auth** across domains

See `docs/ideas/SPLIT-DEPLOYMENT.md` (TODO: create if needed)

**But for now: Combined is simpler and works great!**

---

## Security Checklist

- [ ] Cloudflare Access enabled (if multi-user)
- [ ] WAF rules configured
- [ ] Rate limiting enabled
- [ ] DDoS protection on
- [ ] SSL/TLS set to Full (strict)
- [ ] HSTS enabled
- [ ] Automatic HTTPS rewrites on
- [ ] Server firewall configured (deny all, allow Docker)
- [ ] Database not exposed to internet
- [ ] Regular backups configured
