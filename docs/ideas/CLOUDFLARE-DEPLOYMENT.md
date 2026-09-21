# Cloudflare Tunnel Deployment Strategy

## Overview

Deploy the chat bot on a private server (home lab, VPS, or on-premise) and expose it securely via Cloudflare Tunnel **without opening firewall ports**.

**Architecture:** Combined deployment (frontend + backend + database on same server)

## Why Combined Deployment?

| Factor | Combined ✅ | Split |
|--------|-------------|-------|
| **Deployment** | Unified pipeline | Separate pipelines |
| **CORS** | Not needed | Must configure |
| **Auth** | Simple cookies | Cross-domain complexity |
| **Debugging** | Single environment | Distributed tracing |
| **Performance** | Localhost latency | Network calls |
| **Scaling** | Vertical (upgrade server) | Horizontal (add instances) |

For personal or small-scale use, a combined deployment is simpler and adequate.

## Implementation Strategy

### 1. Configure the Environment
Set the environment variables for your application, pointing the database and AI provider to the appropriate internal or external services.

### 2. Start Services
Launch your frontend, backend, and database services simultaneously, typically using a container orchestrator or process manager.

### 3. Install and Configure cloudflared
Install the `cloudflared` daemon alongside your services. It can be run as an additional container or directly on the host. 

Authenticate the daemon with your Cloudflare account, create a named tunnel, and configure the tunnel ingress to route traffic from your desired domain to your internal frontend service. 

### 4. Configure DNS
Ensure your Cloudflare DNS is configured with a CNAME record pointing your domain to the generated tunnel ID, and that it is proxied through Cloudflare.

## Cloudflare-Specific Configuration

### SSE Over Cloudflare Tunnel

Cloudflare Tunnel supports Server-Sent Events well. The default idle timeout (usually 90 seconds) is generally sufficient for chat streams, and there is no maximum duration limit.

### Caching and Security
Configure Cloudflare to cache static assets while bypassing the cache for API routes. 
Set the security level appropriately and consider enabling Cloudflare Access to require authentication before reaching the application.

## Monitoring & Alerts
Use the Cloudflare dashboard to monitor traffic, tunnel health, and TLS status. Use your local server's orchestration tools to monitor container resource usage and service health.
