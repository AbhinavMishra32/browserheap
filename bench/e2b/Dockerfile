# The machine the memory benchmark runs on: an E2B sandbox (Linux, 8 CPUs,
# 8 GB), the same for every tool, so the numbers don't depend on a laptop.
#
#   node --env-file=../../.env bench/e2b/run.ts template     builds this on E2B
#
# Everything is installed now, at the versions measured; bench/e2b/run.ts
# uploads the benchmark's code into /opt/bench when it runs.
FROM node:26-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git procps python3 fontconfig \
     fonts-liberation fonts-dejavu-core fonts-noto-cjk fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f

# Browsers go in one shared place, whoever runs them.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# agent-tabs' own packages, and Playwright's headless shell it runs on.
WORKDIR /opt/bench
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@10.23.0 \
  && pnpm install --frozen-lockfile \
  && ./node_modules/.bin/playwright-core install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/*

# The other tools, at the versions measured. They launch Google Chrome, as
# they do on a Mac that has it; agent-browser downloads its own Chrome.
WORKDIR /opt/bench/bench/others
COPY bench/others/package.json bench/others/package-lock.json ./
RUN npm install --no-audit --no-fund \
  && npx playwright install --with-deps chrome \
  && node_modules/agent-browser/bin/agent-browser.js install --with-deps \
  && rm -rf /var/lib/apt/lists/*

# The other engines: Lightpanda and Obscura, at the versions measured.
RUN mkdir -p /opt/engines/obscura \
  && curl -fsSL -o /opt/engines/lightpanda \
     https://github.com/lightpanda-io/browser/releases/download/1.0.0/lightpanda-x86_64-linux \
  && chmod +x /opt/engines/lightpanda \
  && curl -fsSL https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.4/obscura-x86_64-linux.tar.gz \
     | tar -xz -C /opt/engines/obscura

# browser-use, in its own Python.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
  && uv venv .venv --python 3.12 \
  && uv pip install --python .venv/bin/python browser-use==0.13.11

WORKDIR /opt/bench
