FROM node:22-alpine

WORKDIR /app
COPY relay.js /app/relay.js
COPY site /app/site

ENV PORT=8443
ENV HTTP_PORT=8080
ENV SITE_DIR=/app/site

EXPOSE 8443 8080

CMD ["node", "/app/relay.js"]
