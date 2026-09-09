# chain-svc: treasury, spawn, resolver and the chain event tail.
#
# Bun rather than node, and pinned by digest as well as tag. The build context
# is the REPO ROOT, not this directory: chain/svc is a bun workspace member and
# the lockfile lives at the root, so `--frozen-lockfile` is only possible from
# there. Spec S7 writes `build: ./svc`, which would install unpinned.
#
# There is deliberately NO Foundry in this image. S7 had chain-svc run the
# deploy script itself, which would mean shipping a Solidity toolchain, the
# contract sources and ~30MB of vendored libraries inside the service that
# holds every wallet key. The deploy is a one-shot `chain-deploy` service
# instead, and compose sequences it with service_completed_successfully.
FROM oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json bun.lock ./
COPY chain/svc/package.json chain/svc/package.json
RUN bun install --frozen-lockfile --ignore-scripts

COPY chain/svc chain/svc
WORKDIR /app/chain/svc

# A named volume inherits the ownership of the image directory it is mounted
# over, so these must exist and belong to the runtime user before the volume is
# created. Without this the service dies at startup with "unable to open
# database file" - which reads like a corrupt store rather than a permissions
# problem, and cost a debugging round trip to find.
USER root
RUN mkdir -p /keystore /policies /store && chown -R bun:bun /keystore /policies /store

# Non-root: this process holds the treasury key in memory and every agent's
# encrypted key on a volume.
USER bun

EXPOSE 7000

# Liveness only - no wallet, supply or registry data - because it is the one
# route that answers without a credential.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD bun -e "fetch('http://127.0.0.1:7000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "src/index.ts"]
