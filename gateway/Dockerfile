FROM node:22-alpine

WORKDIR /app

COPY node_modules ./node_modules
COPY gateway ./gateway

WORKDIR /app/gateway

RUN node ../node_modules/typescript/bin/tsc -p ./tsconfig.json

ENV AYLA_GATEWAY_PORT=8089
EXPOSE 8089

CMD ["node", "dist/server.js"]
