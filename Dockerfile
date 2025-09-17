FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

# Our Ruby API is served over port 3000
EXPOSE 3001

CMD ["npm", "run", "start"]
