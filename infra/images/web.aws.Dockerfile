# The frontend as aws-prod runs it: the repository's own image, serving
# static files only. The load balancer sends /api/* to the backend, so
# nginx proxies nothing.
# BASE is the image built from /Dockerfile.frontend (see build_layered).
ARG BASE
FROM ${BASE}

COPY web.nginx.conf /etc/nginx/conf.d/default.conf
