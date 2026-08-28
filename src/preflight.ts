import { run } from "./exec";

/**
 * Confere as ferramentas ANTES de pegar qualquer job.
 *
 * O launchd não herda o PATH do shell: sob ele o `ffprobe` de `~/.local/bin`
 * simplesmente não existia, e a esteira só descobria isso lá no meio da
 * composição — depois de já ter gasto os clipes. Falhar na largada, com o
 * caminho na mensagem, é a diferença entre um susto e uma rodada perdida.
 */
export async function preflight(): Promise<void> {
  const faltando: string[] = [];

  for (const bin of ["ffmpeg", "ffprobe", "python3"]) {
    await run("which", [bin]).catch(() => faltando.push(bin));
  }

  if (!faltando.length) {
    await run("python3", ["-c", "import numpy"]).catch(() => faltando.push("numpy (python3 -m pip install numpy)"));
  }

  if (faltando.length) {
    throw new Error(
      `faltam ferramentas no PATH: ${faltando.join(", ")}\n` +
      `PATH visto pelo worker: ${process.env.PATH}\n` +
      `Se estiver rodando pelo launchd, ajuste o PATH em worker/launchd/.`,
    );
  }
}
