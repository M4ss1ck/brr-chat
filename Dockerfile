# syntax=docker/dockerfile:1
# The production image: the compiled single binary (ADR 0002) on distroless, nothing else
# (ADR 0022). Base images are pinned by digest; Dependabot proposes bumps. The Bun tag
# below must match .bun-version, which apps/server/test/container.test.ts enforces.

FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS build
WORKDIR /src

# Manifests first, so a source-only change reuses the dependency layer.
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# --ignore-scripts: the root `prepare` script configures git hooks, and there is no git here.
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/protocol packages/protocol
COPY apps/web apps/web
COPY apps/server apps/server
# Builds the shell, regenerates the server's embedded copy, then compiles one binary.
RUN bun run --cwd apps/server compile
# The byte budgets are part of the contract; an image never ships a shell that breaks them.
RUN bun test apps/web/test/budget.test.ts packages/protocol/test/budget.test.ts

# Volume mount points, owned by the runtime user so fresh named volumes inherit it.
RUN mkdir -p /out/data /out/backups

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /src/apps/server/dist/brr-chat /brr-chat
COPY --from=build --chown=65532:65532 /out/data /data
COPY --from=build --chown=65532:65532 /out/backups /backups
USER 65532:65532
ENV HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/brr-chat.db \
    BACKUP_DIR=/backups
EXPOSE 3000
VOLUME ["/data", "/backups"]
# Exec form: there is no shell. The binary probes its own /healthz (ADR 0022).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD ["/brr-chat", "healthcheck"]
ENTRYPOINT ["/brr-chat"]
