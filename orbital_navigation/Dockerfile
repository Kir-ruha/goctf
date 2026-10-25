FROM rust:1.90-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --create-home orbit \
    && mkdir /data && chown orbit:orbit /data
COPY --from=build /build/target/release/orbit-ctf /usr/local/bin/orbit-ctf
USER orbit
ENV LISTEN_ADDR=0.0.0.0:8080 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/orbit-ctf"]
