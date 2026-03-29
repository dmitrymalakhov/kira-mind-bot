FROM node:23-alpine

RUN apk add --no-cache python3 make g++ gcc

WORKDIR /usr/src/app

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3011
CMD ["npm", "start"]
