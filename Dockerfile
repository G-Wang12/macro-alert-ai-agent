FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    git \
    libssl-dev \
    libzmq3-dev \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY ts_agent/package*.json ./ts_agent/
RUN cd ts_agent && npm ci

COPY . .

RUN cmake -S cpp_engine -B cpp_engine/build -DCMAKE_BUILD_TYPE=Release \
  && cmake --build cpp_engine/build --parallel

RUN cd ts_agent && npm run build

RUN cd ts_agent && npm prune --omit=dev

CMD ["./scripts/start-railway.sh"]
