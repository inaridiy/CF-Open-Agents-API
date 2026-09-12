# Keep this image on exactly the same version as @cloudflare/sandbox.
FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1
RUN npm install --global @openai/codex@0.154.0
EXPOSE 4500
