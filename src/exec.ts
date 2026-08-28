import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Teto de wall-clock por processo.
 *
 * O maior render legítimo medido aqui leva segundos; 10 minutos é folga larga.
 * O que isso barra é o caso patológico: em 27/08 um `filter_complex` com o
 * avatar a 30fps e a referência a 60fps nunca convergia, e o ffmpeg ficou 13
 * minutos a 450% de CPU escrevendo um arquivo que só crescia. Sem teto, o passo
 * segurava o lease e esquentava a máquina até alguém matar na mão.
 */
const TIMEOUT_MS = Number(process.env.WORKER_EXEC_TIMEOUT_MS ?? 10 * 60_000);

/** Roda um binário e devolve stdout. Erro de processo vira exceção com stderr junto. */
export function run(cmd: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    // `detached` põe o processo num GRUPO próprio — e é o grupo que morre no
    // timeout. Os scripts python lançam o ffmpeg como filho: matar só o python
    // deixava o ffmpeg órfão queimando CPU, que foi exatamente o que aconteceu.
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });

    let out = "";
    let err = "";
    let estourou = false;

    const matarGrupo = () => {
      estourou = true;
      try {
        if (p.pid) process.kill(-p.pid, "SIGKILL");
      } catch {
        p.kill("SIGKILL");
      }
    };

    const relogio = setTimeout(matarGrupo, timeoutMs);

    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));

    p.on("error", (e) => {
      clearTimeout(relogio);
      reject(e);
    });

    p.on("close", (code) => {
      clearTimeout(relogio);
      if (estourou) {
        return reject(new Error(
          `${cmd} passou de ${timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} min` : `${Math.round(timeoutMs / 1000)}s`} e foi interrompido — ` +
          `o processo e os filhos dele foram encerrados. ${err.slice(-500)}`,
        ));
      }
      if (code === 0) return resolve(out);
      reject(new Error(`${cmd} saiu ${code}: ${err.slice(-2000)}`));
    });
  });
}

/**
 * Diretório temporário que se limpa sozinho. Vídeo ocupa dezenas de MB e o
 * worker é longo-vivo — sem isso o disco do container enche em algumas rodadas.
 */
export async function comTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "render-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Tamanho do bloco de download.
 *
 * Medido em 27/08 contra o Storage do Supabase: um GET do objeto inteiro entrega
 * os primeiros megabytes a ~5 MB/s e depois estrangula — 15,9 MB em 240s, ainda
 * desacelerando, num arquivo de 23,9 MB. O mesmo objeto pedido em ranges de 4 MB
 * volta a 5,4 MB/s do começo ao fim. Por isso o download é fatiado: não é
 * paranoia, é o único jeito de um clipe de 1080x1920 chegar aqui.
 */
const BLOCO = 4 * 1024 * 1024;

/** Tentativas por bloco. Bloco que estagna aborta e é repetido; o arquivo inteiro não. */
const TENTATIVAS = 3;

async function bloco(url: string, inicio: number, fim: number, timeoutMs: number): Promise<Response> {
  let ultimo: unknown;
  for (let t = 1; t <= TENTATIVAS; t++) {
    try {
      const r = await fetch(url, {
        headers: { Range: `bytes=${inicio}-${fim}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      ultimo = e;
    }
  }
  throw new Error(
    `download falhou no bloco ${inicio}-${fim} após ${TENTATIVAS} tentativas — ` +
    `${(ultimo as Error)?.message ?? ultimo} — ${url}`,
  );
}

/**
 * Baixa uma URL pública pra um arquivo local, em blocos.
 *
 * O timeout é POR BLOCO, não pro arquivo todo: um arquivo grande numa conexão
 * boa nunca deveria estourar só por ser grande, mas um bloco que estagna precisa
 * morrer rápido pra ser repetido. Sem timeout nenhum, o passo trava segurando o
 * lease até o worker ser dado como morto.
 */
export async function baixar(url: string, destino: string, timeoutPorBlocoMs = 60_000): Promise<string> {
  const { open } = await import("node:fs/promises");

  // O primeiro bloco também é a sonda: diz o tamanho total e se o servidor honra
  // range. Uma requisição a menos que um HEAD separado.
  const primeiro = await bloco(url, 0, BLOCO - 1, timeoutPorBlocoMs);

  const fh = await open(destino, "w");
  try {
    await fh.write(Buffer.from(await primeiro.arrayBuffer()));

    // 200 = servidor ignorou o Range e mandou o arquivo inteiro; já está no disco.
    if (primeiro.status !== 206) return destino;

    const total = Number(primeiro.headers.get("content-range")?.split("/")[1] ?? 0);
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error(`content-range ilegível em ${url}`);
    }

    for (let inicio = BLOCO; inicio < total; inicio += BLOCO) {
      const r = await bloco(url, inicio, Math.min(inicio + BLOCO, total) - 1, timeoutPorBlocoMs);
      await fh.write(Buffer.from(await r.arrayBuffer()));
    }

    const { size } = await fh.stat();
    if (size !== total) throw new Error(`download incompleto: ${size} de ${total} bytes — ${url}`);
    return destino;
  } finally {
    await fh.close();
  }
}

export async function lerArquivo(caminho: string): Promise<Buffer> {
  return readFile(caminho);
}
