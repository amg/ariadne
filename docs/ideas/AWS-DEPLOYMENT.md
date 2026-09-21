# AWS Deployment Guide

This guide covers deploying the chat bot to AWS with proper SSE (Server-Sent Events) support.

## ⚠️ SSE Considerations on AWS

### The Problem
Server-Sent Events require long-lived HTTP connections. AWS services have timeout limits:

| Service | Idle Timeout | Max Duration | Suitable for SSE |
|---------|-------------|--------------|------------------|
| API Gateway (REST) | 29 seconds | 29 seconds | ❌ No |
| API Gateway (WebSocket) | N/A | N/A | ✅ Yes (different protocol) |
| Application Load Balancer (ALB) | 60 seconds (configurable to 4000s) | N/A | ⚠️ With configuration |
| Network Load Balancer (NLB) | 350 seconds idle, no hard limit | N/A | ✅ Yes (recommended) |
| CloudFront | 60 seconds idle | N/A | ⚠️ With keepalive |

### Recommended Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌─────────────┐
│   Users     │────▶│  CloudFront  │────▶│     NLB     │────▶│   ECS/Fargate│
│  (Browser)  │     │   (Optional) │     │  (Port 3001)│     │  (Backend)  │
└─────────────┘     └──────────────┘     └─────────────┘     └─────────────┘
                                                                    │
                                                                    ▼
                                                            ┌─────────────┐
                                                            │   RDS       │
                                                            │ (PostgreSQL)│
                                                            └─────────────┘
```

### Why Network Load Balancer (NLB)?

1. **Long-lived connections**: NLB supports connections up to 350 seconds idle timeout
2. **TCP passthrough**: Operates at Layer 4, no HTTP timeout interference
3. **Static IP**: Can assign Elastic IPs if needed
4. **Cost-effective**: Lower cost than ALB for simple TCP routing

### Alternative: WebSocket Migration

For better AWS compatibility, consider migrating from SSE to WebSocket:

**Pros:**
- Native AWS WebSocket API Gateway support
- Bidirectional communication
- Better mobile/network resilience
- Automatic reconnection handling

**Cons:**
- Requires code changes (SSE → WebSocket)
- More complex client-side logic

## Environment Variables for AWS

```bash
# Server configuration
PORT=3001
HOST=0.0.0.0

# Database (RDS endpoint)
DATABASE_URL=postgres://user:password@your-rds-endpoint.rds.amazonaws.com:5432/chatbot

# AI Provider
DEEPINFRA_API_KEY=your-api-key
DEFAULT_MODEL=Qwen/Qwen3.5-9B

# SSE Optimization for AWS
# Reduce idle timeout to send keepalive more frequently
AI_STREAM_IDLE_TIMEOUT_MS=30000  # 30 seconds
```

## ECS Task Definition Strategy

When defining the ECS task, ensure the container specifies the correct port and uses the AWSVPC network mode. 

## Frontend SSE Client Optimization

The frontend client should implement connection keepalive and reconnection logic to handle AWS service timeouts.
// Implement application-level ping/pong if needed
// (send periodic messages to keep connection alive)

## CloudFront Configuration (Optional)

If using CloudFront in front of NLB:

1. **Increase Origin Timeout**: Set to 60 seconds maximum
2. **Enable Keep-Alive**: Configure origin to use HTTP/1.1 with keep-alive
3. **Cache Behavior**: Set TTL to 0 for `/api/*` paths (no caching)
4. **WebSocket Support**: Enable if migrating to WebSocket

## Monitoring & Alerts

Set up CloudWatch alarms for:

- **TargetConnectionErrorCount** (NLB): Connection failures
- **HTTPCode_Target_5XX_Count**: Backend errors
- **ResponseTime**: Stream latency
- **Database Connections**: RDS connection count

## Cost Optimization

1. **Use Fargate Spot**: For non-critical workloads (70% savings)
2. **Auto-scaling**: Scale to zero during low-traffic periods
3. **RDS Storage**: Use gp3 volumes with auto-scaling
4. **CloudFront**: Cache static assets aggressively

## Security Checklist

- [ ] Enable VPC for ECS tasks
- [ ] Use Security Groups to restrict database access
- [ ] Store secrets in AWS Secrets Manager
- [ ] Enable RDS encryption at rest
- [ ] Use HTTPS/TLS for all connections
- [ ] Implement CORS properly for your domain
- [ ] Enable CloudTrail for API auditing

## Testing SSE on AWS

Before production deployment:

```bash
# Test connection persistence
curl -N http://your-nlb-dns:3001/api/threads/test/chat \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "test"}]}'

# Monitor connection duration
# Should stay open for the duration of the stream
```

## Migration Checklist

- [ ] Update environment variables
- [ ] Build and push Docker images to ECR
- [ ] Create RDS PostgreSQL instance with pgvector extension
- [ ] Configure NLB with target group
- [ ] Deploy ECS service
- [ ] Test SSE connection persistence
- [ ] Configure CloudWatch logging
- [ ] Set up alarms and monitoring
- [ ] Test failover and recovery
- [ ] Document runbook for operations

## Troubleshooting

### SSE Connection Drops After 60 Seconds

**Cause**: ALB idle timeout or CloudFront timeout

**Solution**: 
1. Switch to NLB
2. Or increase ALB timeout to 4000s maximum
3. Implement application-level keepalive

### Database Connection Errors

**Cause**: RDS not accessible from ECS

**Solution**:
1. Check Security Group rules
2. Verify VPC configuration
3. Ensure RDS is in same VPC or has VPC peering

### High Latency on Stream Start

**Cause**: Cold start on Fargate

**Solution**:
1. Use provisioned concurrency
2. Keep minimum task count >= 1
3. Optimize container image size
