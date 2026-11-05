FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --omit=optional && npm cache clean --force
COPY server.mjs ./
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/uploads /data/metadata && chown -R node:node /app /data
USER node
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "server.mjs"]
