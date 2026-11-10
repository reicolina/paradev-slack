FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
# Linked accounts live in STORE_PATH; mount a volume at /data so they survive deploys.
RUN mkdir -p /data && chown node:node /data
ENV STORE_PATH=/data/store.json
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
