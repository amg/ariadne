---
description: aws-prod's front door is CloudFront with a web ACL, in front of a load balancer that has no public address; Cloudflare keeps only the hostname's DNS, and load runs come in the same way users do.
---

# ADR 0018: CloudFront is aws-prod's front door

## Status
Accepted. Replaces the "Edge: Cloudflare's proxy to a locked origin"
part of ADR 0014. For aws-prod, the edge where ADR 0008 keeps client
identity and the sign-in limit is now CloudFront's; the rest of 0008
stands.

## Context
aws-prod sat behind Cloudflare's proxy, which held a public load
balancer to itself with a client certificate and an address list. On
the Free plan, Cloudflare's edge turns away traffic from cloud address
ranges, the load generators included, and cannot hold a sign-in rate
limit to one hostname or let the generators past it. So every load run
skipped the edge and went straight to the load balancer, and the only
gate in front of aws-prod was the allow-list.

Without an edge, every new user's handshake lands on the load
balancer. During a surge the load balancer grows to meet them, and
while it grows, new connections fail, though the app itself keeps up.
Real users arrive in waves too, so a surge is not only a test's doing.

## Decision
CloudFront is the front door, and Cloudflare keeps only the hostname's
DNS record. CloudFront ends TLS, caches the web app's static files by
their own cache headers, and passes the API through uncached. A web ACL
at the edge lets in only the operator and requests carrying the raise's
load key, and limits sign-ins per address, counting none that carry the
key. The app's own sign-in limit stays off, as before.

The load balancer has no public address. CloudFront reaches it from
inside AWS, and nothing else can, so the last hop needs no TLS and no
certificates. It still routes only the hostname.

Load runs come in the way users do, through the edge, so a run measures
what users get and the edge it measures is the one production keeps.
There is no second path around it.

The certificate costs nothing and lives with core. The distribution and
the web ACL are raised and removed with the app, so nothing bills by the
hour while aws-prod is down.

## Considered
* **A public load balancer locked to CloudFront** by its published
  address list and a secret header: the load balancer stays public and
  keeps doing TLS, and the address list fills most of a security group.
* **Keeping Cloudflare's proxy in front of CloudFront**: two edges for
  one job, and the Free plan's limits stay.
* **A Network Load Balancer**, which needs no growing: it gives up
  routing by path and by host, and the app would have to take both
  over. A bigger change, for a problem the edge mostly removes.
* **Paying for a Cloudflare plan** that can hold the rate limit: the
  generators still meet the cloud-range blocking, and the rate limit
  could test a header only on the top plan.

## Consequences
* **Easier**: one way in for users, the operator and the generators. A
  sign-in limit exists at the edge, so opening aws-prod no longer waits
  on one. The edge's own errors show in a run's record beside the load
  balancer's.
* **Harder**: a raise and a teardown each take some minutes longer,
  since a distribution is slow to create and must be disabled before it
  is deleted. The certificate and the web ACL live in another region.
* **Unchanged**: each open push stream still holds one connection from
  the edge to the load balancer, and a stream the load balancer cuts
  while it grows is still cut, and reopens.
