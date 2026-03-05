FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git \
    && curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash claude \
    && mkdir -p /home/claude/.claude \
    && chown -R claude:claude /home/claude

USER claude
ENV HOME=/home/claude
ENV PATH="/home/claude/.local/bin:${PATH}"

# Install Claude Code native binary (SEA — single executable, no Node.js needed)
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /home/claude/workspace

CMD ["sleep", "infinity"]
