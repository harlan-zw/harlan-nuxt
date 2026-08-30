FROM ubuntu:24.04

ARG RUNNER_VERSION=2.336.0
ARG RUNNER_SHA256=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    jq \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0t64 \
    libicu74 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libssl3t64 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    pkg-config \
    python3 \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*
# The libasound/libatk/libnss/libx* set is what Playwright's bundled Chromium
# needs to launch. Workflows then install browsers with
# `playwright install chromium`, without `--with-deps`, since the runner user
# has no root for apt-get.

RUN useradd --create-home --home-dir /home/runner --shell /bin/bash runner

WORKDIR /opt/actions-runner

RUN curl --fail --location --show-error \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    --output /tmp/actions-runner.tar.gz \
  && echo "${RUNNER_SHA256}  /tmp/actions-runner.tar.gz" | sha256sum --check --strict \
  && tar --extract --gzip --file /tmp/actions-runner.tar.gz \
  && rm /tmp/actions-runner.tar.gz \
  && chown --recursive runner:runner /opt/actions-runner

COPY --chown=root:root entrypoint.sh /usr/local/bin/harlan-desktop-runner-entrypoint

RUN chmod 0755 /usr/local/bin/harlan-desktop-runner-entrypoint

USER runner

ENTRYPOINT ["/usr/local/bin/harlan-desktop-runner-entrypoint"]
