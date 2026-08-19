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
    libicu74 \
    libssl3t64 \
    pkg-config \
    python3 \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

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
