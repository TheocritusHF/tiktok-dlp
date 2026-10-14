FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    python3-pip \
    tini \
    tzdata \
  && python3 -m pip install --no-cache-dir --break-system-packages \
    'curl_cffi>=0.10' \
    'gallery-dl==1.32.16' \
    'Pillow>=8.1.1' \
    'instagrapi==3.0.16' \
  && python3 -c 'import curl_cffi; import instagrapi; print(instagrapi.__name__)' \
  && test "$(gallery-dl --version)" = "1.32.16" \
  && curl --fail --location --retry 3 \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp \
    --output /usr/local/bin/yt-dlp \
  && echo "1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && yt-dlp --version \
  && yt-dlp --list-impersonate-targets 2>&1 | grep -qi chrome \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Separate Python module for Instagram DASH; the standalone TikTok binary is unchanged.
COPY requirements-instagram-dash.txt /tmp/requirements-instagram-dash.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages --no-deps \
      --require-hashes --target /opt/instagram-dash -r /tmp/requirements-instagram-dash.txt \
  && PYTHONPATH=/opt/instagram-dash python3 -c 'from yt_dlp.version import __version__; assert __version__ == "2026.08.19"' \
  && rm /tmp/requirements-instagram-dash.txt

COPY scripts/verify-gallery-dl.py /tmp/verify-gallery-dl.py
RUN python3 /tmp/verify-gallery-dl.py && rm /tmp/verify-gallery-dl.py

COPY package*.json ./

RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY README.md ./
RUN mkdir -p /app/data/downloads /app/cookies && chown -R node:node /app

USER node

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.HTTP_PORT||8080;require('http').get('http://127.0.0.1:'+p+'/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["npm", "start"]
