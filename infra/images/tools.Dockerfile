# One-off database work inside the app network. By default it warms a
# freshly restored database: see warm.sql.
FROM postgres:16-alpine

ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
COPY warm.sql /warm.sql

ENV PGSSLMODE=verify-full \
    PGSSLROOTCERT=/etc/ssl/certs/rds-global-bundle.pem

USER postgres
CMD ["psql", "--set=ON_ERROR_STOP=1", "--file=/warm.sql"]
