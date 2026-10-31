FROM node:22-alpine

WORKDIR /app
COPY relay.js /app/relay.js

ENV PORT=8443
EXPOSE 8443

CMD ["node", "/app/relay.js"]
