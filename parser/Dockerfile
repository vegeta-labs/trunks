# Parser container (tech design T7): no network (compose: network_mode none), no application secrets, read-only
# root file system, non-root user, resource limits from compose; bubblewrap isolates every task.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ca-certificates python3 python3-seccomp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY parser ./parser
COPY src/lib ./src/lib
COPY src/ingest ./src/ingest
# the per-task seccomp filter, built for this image's architecture
RUN python3 parser/seccomp-gen.py /app/parser/task.bpf && apt-get purge -y python3-seccomp && apt-get autoremove -y
RUN mkdir -p /run/parser && chown 10001:10001 /run/parser
USER 10001:10001
ENV NODE_ENV=production PARSER_SOCKET=/run/parser/parser.sock PARSER_JOBS=/jobs
CMD ["node", "--experimental-strip-types", "--no-warnings", "parser/server.ts"]
