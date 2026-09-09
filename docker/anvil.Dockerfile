# The private chain for Operation PowerOUT: one Anvil node, zero gas, state on a
# volume so a restart does not wipe the game's balances.
#
# Pinned by tag AND digest (spec S3.2): the tag alone is mutable, so a rebuild
# months from now would silently pick up a different Anvil than the one that was
# reviewed. Update both together, deliberately, or not at all.
FROM ghcr.io/foundry-rs/foundry:v1.8.1@sha256:0c00cb0bda1ab1b91c9a6bf60f4c76c09c1a8870824b6d4718afbabacf6f9a17

# The base image runs as uid 1000. A named volume mounted at /state inherits the
# ownership of the image's directory, so create it owned by that uid here or
# anvil cannot write its state dump and the persistence guarantee is silently
# lost (it logs, then keeps serving from memory).
USER root
RUN mkdir -p /state && chown 1000:1000 /state
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
USER 1000

EXPOSE 8545
VOLUME ["/state"]

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD cast block-number --rpc-url http://localhost:8545 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
