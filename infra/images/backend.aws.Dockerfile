# The backend as aws-prod runs it: the repository's own image, plus the
# RDS certificate authority, so every database connection is TLS and
# verified. Used for the API, the worker and mock inference.
# BASE is the image built from /Dockerfile.backend (see build_layered).
ARG BASE
FROM ${BASE}

USER root
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
USER node

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem \
    PGSSLMODE=verify-full
