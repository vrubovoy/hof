# Hof server image (ARCHITECTURE.md §7, §9). There is no build step: Node runs the .ts sources
# directly, so the image holds runtime dependencies and src/ only.
FROM node:24.21.0-trixie-slim

WORKDIR /app

# Runtime dependencies only. This layer is rebuilt only when package*.json change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code. Files stay owned by root, so the server process cannot change them.
COPY src ./src
# Readable for the node user whatever umask the checkout had: with umask 077 git writes new files
# with mode 600, and Node could read neither its code nor package.json ("type"). Nobody gets write
# access.
RUN chmod -R a+rX package.json src

# The node user (uid 1000) comes with the base image.
USER node
CMD ["node", "src/main.ts"]
