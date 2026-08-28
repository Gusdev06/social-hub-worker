import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { uploadBuffer } from "../compartilhado/lib/storage";
import { baixar, comTemp, lerArquivo, run } from "../exec";
import { idioma, restaurarPontuacao } from "../compartilhado/lib/roteiro";
import { CUSTO_CENTS, rodar } from "../wavespeed";
import { SCRIPTS } from "../caminhos";
import type { Job, StepResult } from "../tipos";

type SaidaWhisper = { text?: string; srt?: string; text_details?: { start: number; end: number; text: string }[] };

/**
 * Transcreve o criativo de referência e fatia em clipes que o Kling sustenta.
 *
 * Duas coisas saem daqui além do texto: a **duração real** do original (que
 * calibra o ritmo — locução de anúncio varia de 3,5 a 6 sílabas/s, e o default
 * genérico erra 40%) e o **áudio extraído**, que a versão com voz original usa
 * no lipsync.
 */
export const roteiro = async (job: Job): Promise<StepResult> =>
  comTemp(async (dir) => {
    const duracao = job.manifest.estrutura?.duracao ?? 0;

    // Roteiro corrigido à mão manda sobre a máquina. O Whisper come palavra —
    // na referência da Sophia ele perdeu o "There's" que abre o gancho, e o
    // gancho é a parte que mais importa do criativo.
    let texto = job.manifest.roteiroManual?.trim() ?? "";
    let alinhamento = "";
    let custo = 0;

    if (!texto) {
      const t = await rodar("wavespeed-ai/openai-whisper-with-video", {
        video: job.refVideoUrl,
        language: "auto",
        enable_timestamps: true,
      });
      custo = CUSTO_CENTS["wavespeed-ai/openai-whisper-with-video"];

      const saida = (t.bruto as { outputs?: SaidaWhisper[] })?.outputs?.[0];
      const cru = saida?.text?.trim();
      if (!cru) throw new Error("whisper não devolveu transcrição");

      // O Whisper entrega um bloco corrido sem ponto; o fatiador corta em
      // fronteira de frase. Restaurar a pontuação é o que torna o corte
      // possível — e a conferência palavra a palavra impede a copy de mudar.
      const p = await restaurarPontuacao(cru);
      texto = p.texto;
      const total = cru.split(/\s+/).filter(Boolean).length;
      if (p.alinhadas < total) alinhamento = `${total - p.alinhadas} palavra(s) sem pontuação alinhada`;
    }

    // --ref-dur calibra o ritmo no PRÓPRIO original. É o ritmo do campeão que
    // manda; sem isso os clipes saem com fala acelerada ou frase cortada.
    const arq = join(dir, "roteiro.txt");
    await writeFile(arq, texto, "utf8");
    const chunk = await run("python3", [
      join(SCRIPTS, "chunk_roteiro.py"), arq, "--json",
      "--lang", idioma(texto),
      ...(duracao ? ["--ref-dur", String(duracao)] : []),
    ]);

    const { clipes, ritmo } = JSON.parse(chunk) as {
      ritmo: number;
      clipes: { n: number; texto: string; silabas: number; duracao_kling: number }[];
    };

    // Guarda de sanidade. Um clipe com 126 sílabas significa que o fatiador não
    // achou fronteira de frase e empilhou o roteiro inteiro num clipe só — o
    // Kling aceitaria e devolveria fala acelerada, US$ 0,56 fora. Já 15s com
    // ~59 sílabas é o teto legítimo do modelo, não um erro.
    const estourado = clipes.find((c) => c.silabas > 70);
    if (estourado) {
      throw new Error(
        `clipe ${estourado.n} com ${estourado.silabas} sílabas em ${estourado.duracao_kling}s — ` +
        `o roteiro não tem pontuação suficiente pra fatiar` +
        (alinhamento ? ` (${alinhamento})` : "") +
        `. Corrija o roteiro no painel e libere de novo.`,
      );
    }

    // O áudio original — a versão A depende dele e ele some se a referência sair
    // do Storage. Extrair agora custa nada.
    const video = await baixar(job.refVideoUrl, join(dir, "ref.mp4"));
    const m4a = join(dir, "audio-original.m4a");
    await run("ffmpeg", ["-y", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "aac", m4a]);
    const { publicUrl: audioUrl } = await uploadBuffer(await lerArquivo(m4a), "audio-original.m4a", "audio/mp4");

    return {
      patch: {
        roteiro: clipes.map((c) => ({
          n: c.n, texto: c.texto, silabas: c.silabas, duracao: c.duracao_kling,
        })),
        roteiroTexto: texto,
        audioOriginalUrl: audioUrl,
      },
      costCents: custo,
      pause: true,
      msg:
        `${clipes.length} clipe(s) · ${ritmo.toFixed(2)} sílabas/s no original` +
        (alinhamento ? ` · ${alinhamento}` : ""),
    };
  });
