import { join } from "node:path";
import type { RenderEstrutura } from "../compartilhado/db/schema";
import { uploadBuffer } from "../compartilhado/lib/storage";
import { baixar, comTemp, lerArquivo, run } from "../exec";
import { SCRIPTS } from "../caminhos";
import type { Job, StepResult } from "../tipos";

const SCRIPT = join(SCRIPTS, "analisar_estrutura.py");

/**
 * Mede a estrutura de edição do criativo de referência: em que faixas
 * horizontais a tela está dividida e em que instantes o layout muda.
 *
 * Isso é o ativo do produto. Estimar no olho onde termina o talking head erra
 * por dezenas de pixels e a emenda aparece; achar o corte arrastando a barrinha
 * erra por meio segundo e o corte cai no meio de uma palavra. O arquivo tem os
 * dois números — faixas diferentes têm estatística de linha diferente.
 */
export const analisar = async (job: Job): Promise<StepResult> =>
  comTemp(async (dir) => {
    const video = await baixar(job.refVideoUrl, join(dir, "referencia.mp4"));

    const saida = await run("python3", [SCRIPT, video, "--json"]);
    const estrutura = JSON.parse(saida) as RenderEstrutura;

    // Um frame por segmento. Os papéis das faixas ("barra de caption",
    // "painel") são palpite estatístico — quem confirma é o olho, no painel.
    const frames: { segmento: number; t: number; url: string }[] = [];
    for (const [i, seg] of estrutura.segmentos.entries()) {
      const t = seg.inicio + Math.min(1, seg.duracao / 2);
      const jpg = join(dir, `seg-${i + 1}.jpg`);
      await run("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", video, "-vframes", "1", jpg]);
      const { publicUrl } = await uploadBuffer(await lerArquivo(jpg), `seg-${i + 1}.jpg`, "image/jpeg");
      frames.push({ segmento: i + 1, t: Number(t.toFixed(2)), url: publicUrl });
    }

    const cortes = estrutura.cortes.map((c) => `${c.toFixed(2)}s`).join(", ") || "nenhum";

    return {
      patch: { estrutura, frames },
      // Pausa de propósito. O passo seguinte corta em cima dessas medidas — se
      // a leitura das faixas estiver errada, todo o resto da rodada sai errado,
      // e vídeo custa dólar. Confirmar aqui custa dez segundos.
      pause: true,
      msg:
        `${estrutura.largura}x${estrutura.altura} · ${estrutura.duracao.toFixed(2)}s · ` +
        `${estrutura.segmentos.length} segmento(s) · cortes de layout: ${cortes}`,
    };
  });
