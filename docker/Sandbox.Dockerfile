# Keep this image on exactly the same version as @cloudflare/sandbox.
FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.154.0
EXPOSE 4500
