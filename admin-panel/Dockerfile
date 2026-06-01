# Stage 1: Build React app
FROM node:23-alpine AS builder
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production server
FROM node:23-alpine
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG ALL_PROXY
ARG NO_PROXY
WORKDIR /app
RUN npm install --no-save express express-session pg
COPY --from=builder /app/dist ./dist
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
