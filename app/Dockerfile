FROM node:22-alpine

WORKDIR /app
COPY proxyip.js /app/proxyip.js

ENV PORT=8443
EXPOSE 8443

CMD ["node", "/app/proxyip.js"]
