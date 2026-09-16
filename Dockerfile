FROM node:24-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .

# Our Ruby API is served over port 3000
EXPOSE 3001

CMD ["npm", "run", "start"]
