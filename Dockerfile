FROM node:24-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .

# 3001: public LTI API (LMS launches, browser). 3003: internal API called by OnTrack's Rails API
EXPOSE 3001 3003

CMD ["npm", "run", "start"]
