FROM node:24.15.0-bookworm-slim
# Tools setup commands and agents expect, as the 0.x sandbox image shipped them, plus
# squashfs-tools to unpack workspace backups that Sandbox SDK 0.x wrote.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       bash ca-certificates curl git jq procps python3 python3-pip python3-venv squashfs-tools unzip wget \
    && rm -rf /var/lib/apt/lists/*
# Environment packages install into the system Python, as they did on the 0.x image.
RUN printf '[global]\nbreak-system-packages = true\n' > /etc/pip.conf
RUN npm install --global @openai/codex@0.154.0
# Keep this tag on exactly the same version as @cloudflare/sandbox: the shim speaks its protocol.
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# No /workspace in the image: a backup restore replaces the directory, which it cannot do
# to one the image owns. SandboxDO creates it in every new container.
CMD ["sleep", "infinity"]
