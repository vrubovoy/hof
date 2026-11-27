# Hof server image (ARCHITECTURE.md §7, §9). Node runs the .ts sources of the server directly, so
# the image holds runtime dependencies and src/, and the release configuration.
#
# Prototype B of M14 (Issue #167): one build stage — esbuild bundles the React views
# (src/build.ts); the image takes only the bundle from it, not the build dependencies.
FROM node:24.21.0-trixie-slim AS bundle

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY src ./src
RUN node src/build.ts

FROM node:24.21.0-trixie-slim

WORKDIR /app

# Runtime dependencies only. This layer is rebuilt only when package*.json change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code. Files stay owned by root, so the server process cannot change them.
COPY src ./src
COPY --from=bundle /app/src/core/static/build ./src/core/static/build
# Readable for the node user whatever umask the checkout had: with umask 077 git writes new files
# with mode 600, and Node could read neither its code nor package.json ("type"). Nobody gets write
# access.
RUN chmod -R a+rX package.json src

# The release configuration (docs/OPERATIONS.md, section «Образ в реестре»): the server takes
# compose.yaml and deploy/ of the release from the image it runs. The application does not read
# them. The modes are those of Git, 755 for scripts and 644 for the rest, whatever the umask.
COPY compose.yaml ./release/compose.yaml
COPY deploy ./release/deploy
RUN chmod -R u=rwX,go=rX release

# Where the image comes from and of which commit. CI passes the SHA; a local build leaves the
# revision empty.
ARG HOF_REVISION
LABEL org.opencontainers.image.source=https://github.com/vrubovoy/hof \
      org.opencontainers.image.revision=$HOF_REVISION

# The node user (uid 1000) comes with the base image.
USER node
CMD ["node", "src/main.ts"]
