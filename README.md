# Alex Chat Bot

A production-ready, Dockerized chatbot application with real-time streaming, contextual memory, and cost observability.

## Features

- 💬 **Real-time Chat** - Streaming responses via Server-Sent Events (SSE)
- 🧵 **Multi-thread Support** - Multiple conversation sessions per user
- 🧠 **Factual Memory** - Long-term memory extraction for cross-session context recall
- 📊 **Cost Observability** - Token usage tracking and cost calculation per message
- 🐳 **Dockerized** - Easy deployment with Docker Compose

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React + React Router v7 + TypeScript |
| Backend | Node.js (Fastify) + TypeScript |
| Database | PostgreSQL |
| Query Builder | Kysely (type-safe SQL) |
| AI Inference | DeepInfra (OpenAI-compatible endpoints) |
| AI Streaming | Vercel AI SDK |
| Infrastructure | Docker & Docker Compose |

## Quick Start

```bash
# Start all services
docker compose up -d

# Access the application
# Frontend: http://localhost:3000
# Backend: http://localhost:3001
```

## Project Structure

```
alex-chat-bot/
├── frontend/          # React frontend application
├── backend/           # Node.js backend API
├── features/          # Feature domain modules
├── adrs/              # Architecture Decision Records
└── scripts/           # Utility scripts
```

## Documentation

- [Grand Plan](GRAND_PLAN.md) - High-level project requirements and architecture
- [Architecture Decisions](adrs/) - Technical decision records

## License

MIT
