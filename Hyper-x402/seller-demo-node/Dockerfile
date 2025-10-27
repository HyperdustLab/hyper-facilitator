FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm i --omit=dev
COPY . .
EXPOSE 4080
CMD ["npm","start"]

