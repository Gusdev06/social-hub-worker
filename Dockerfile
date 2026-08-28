# Esteira de produção de vídeo.
#
# Precisa de ffmpeg (montagem e composição) e numpy (a leitura de estrutura mede
# estatística por linha de pixel) — por isso não roda em serverless nem em
# hospedagem compartilhada: são binários nativos e um processo vivo o tempo todo.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-numpy ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# As dependências entram antes do código: assim uma mudança de passo não
# invalida a camada de npm ci, que é a cara.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

# Container não roda como root: se um script python for enganado por um arquivo
# de entrada, o estrago fica dentro do container e sem privilégio.
RUN useradd --create-home --uid 10001 esteira \
    && chown -R esteira:esteira /app
USER esteira

# Onde os passos escrevem enquanto trabalham. Vídeo ocupa dezenas de MB por
# rodada; o diretório se limpa sozinho ao fim de cada passo.
ENV TMPDIR=/tmp

EXPOSE 8080

# Sem --env-file: em produção as variáveis vêm do ambiente do container.
CMD ["npx", "tsx", "src/index.ts"]
