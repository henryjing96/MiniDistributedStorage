# Single image used for both roles; entrypoint chosen by compose command.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
# default to coordinator; override `command:` for storage
EXPOSE 9981 9982
ENTRYPOINT ["node"]
CMD ["dist/src/coordinator/main.js"]
