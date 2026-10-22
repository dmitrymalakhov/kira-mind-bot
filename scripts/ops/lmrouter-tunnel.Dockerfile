FROM alpine:3.22
RUN apk add --no-cache openssh-client curl
COPY scripts/ops/lmrouter-tunnel.sh /usr/local/bin/lmrouter-tunnel
ENTRYPOINT ["sh", "/usr/local/bin/lmrouter-tunnel"]
