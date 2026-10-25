FROM node:22-bookworm AS web
WORKDIR /web
COPY client/package.json ./
RUN npm install
COPY client/index.html ./index.html
COPY client/src/ ./src/
RUN npm run build

FROM debian:bookworm-slim AS wasmtime
ARG WASMTIME_VERSION=24.0.0
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in amd64) WASMTIME_ARCH=x86_64 ;; arm64) WASMTIME_ARCH=aarch64 ;; *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; esac \
    && curl -fsSL "https://github.com/bytecodealliance/wasmtime/releases/download/v${WASMTIME_VERSION}/wasmtime-v${WASMTIME_VERSION}-${WASMTIME_ARCH}-linux-c-api.tar.xz" -o /tmp/wasmtime.tar.xz \
    && tar -xJf /tmp/wasmtime.tar.xz -C /tmp \
    && mkdir -p /out/include /out/lib \
    && cp -a /tmp/wasmtime-v${WASMTIME_VERSION}-${WASMTIME_ARCH}-linux-c-api/include/. /out/include/ \
    && cp -a /tmp/wasmtime-v${WASMTIME_VERSION}-${WASMTIME_ARCH}-linux-c-api/lib/libwasmtime.so* /out/lib/

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends cmake make g++ clang llvm lld libcpp-httplib-dev libsqlite3-dev nlohmann-json3-dev sqlite3 util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=wasmtime /out/include/ /usr/local/include/
COPY --from=wasmtime /out/lib/ /usr/local/lib/
RUN ldconfig
WORKDIR /srv/lighthouse
COPY server/ ./server/
RUN /bin/sh ./server/build.sh
COPY --from=web /web/dist ./public/
RUN mkdir -p /data /var/log/lighthouse /srv/lighthouse/work \
    && chmod 0700 /data \
    && chmod 0755 /var/log/lighthouse \
    && chmod 0711 /srv/lighthouse/work
EXPOSE 8080
CMD ["/srv/lighthouse/server/lighthouse"]
