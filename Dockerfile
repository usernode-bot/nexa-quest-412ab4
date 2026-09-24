FROM node:22-alpine

# The platform starts this container with runAsNonRoot and no runAsUser, so the
# image itself has to name a numeric, non-zero user. It cannot be a symbolic
# name like `node`: Kubernetes refuses to verify what UID that resolves to, and
# a missing USER on a root-default base image fails the pod with
# CreateContainerConfigError. UID/GID 1000 is the base image's `node` account.
WORKDIR /app

# Dependencies first, so a source-only change reuses this cached layer. The
# install runs as root at build time; the chown hands the result to the runtime
# user so nothing the app touches is left root-owned.
COPY package.json ./
RUN npm install --production && chown -R 1000:1000 /app

# Application source, owned by the runtime user. The app writes nothing to disk
# today (state lives in Postgres), but owning its own tree keeps any incidental
# write from failing against a root-owned path.
COPY --chown=1000:1000 . .

USER 1000:1000

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Exec form on purpose: a shell-form CMD interposes /bin/sh between the init
# process and Node, and that shell swallows SIGTERM, which the graceful
# shutdown handler depends on.
CMD ["node", "server.js"]
