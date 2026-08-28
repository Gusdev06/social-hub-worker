import { join } from "node:path";
import { uploadBuffer } from "../compartilhado/lib/storage";
import { baixar, comTemp, lerArquivo, run } from "../exec";
import { SCRIPTS } from "../caminhos";
import type { Job, StepResult } from "../tipos";

/**
 * Remonta a edição do original por cima do talking head novo: split screen,
 * faixas e ponto de corte, reaproveitando os painéis do criativo de referência.
 *
 * As medidas vêm do passo `analisar` — pixel e segundo lidos do arquivo, não
 * estimados no olho. O único número que ainda é palpite é a **escala** do
 * avatar dentro da faixa de cima, e por isso este passo pausa: sai um preview,
 * e o Gusta compara o tamanho da cabeça com o original antes de aprovar.
 */
export const compor = async (job: Job): Promise<StepResult> =>
  comTemp(async (dir) => {
    const e = job.manifest.edicao;
    const avatarUrl = job.manifest.versaoBUrl;
    if (!e || !avatarUrl) throw new Error("faltou a montagem — o passo anterior não rodou");

    // Só pula quando o original é UMA faixa só — um talking head de tela cheia,
    // sem nada pra remontar. Split screen permanente (faixas, zero corte de
    // layout) NÃO cai aqui: ali a parte dividida é o vídeo inteiro.
    // Defesa em profundidade: geometria degenerada (faixa de altura zero, ou
    // ocupando a tela toda) vira `crop` inválido e o ffmpeg aborta lá dentro,
    // com mensagem que não diz de onde veio o número.
    const altura = job.manifest.estrutura?.altura ?? 0;
    const geometriaInvalida = altura > 0 && (e.topo <= 0 || e.topo >= altura);

    // Com a receita pronta, o compositor sempre tem o que montar — mesmo que
    // todo trecho seja tela cheia. A saída curta abaixo é só pro modelo antigo.
    const temComposicao = e.trechos?.some((t) => t.faixas.length > 1) ?? false;
    if (!temComposicao && (!e.topo || !e.corteRef || geometriaInvalida)) {
      return {
        patch: { compostoUrl: avatarUrl },
        msg: "original sem split screen — talking head entregue direto",
      };
    }

    const ref = await baixar(job.refVideoUrl, join(dir, "ref.mp4"));
    const avatar = await baixar(avatarUrl, join(dir, "avatar.mp4"));
    const saida = join(dir, "composto.mp4");
    const preview = join(dir, "preview.jpg");

    const args = [
      join(SCRIPTS, "montar_composto.py"),
      "--ref", ref, "--avatar", avatar, "-o", saida,
      "--escala", String(e.escala),
      // A receita manda quando existe. Os flags de um corte só ficam pro caso de
      // rodada começada antes da remontagem por segmento.
      ...(e.trechos?.length
        ? ["--trechos", JSON.stringify(e.trechos)]
        : ["--topo", String(e.topo), "--corte-ref", String(e.corteRef), "--corte", String(e.corte)]),
    ];

    // Duas passadas: com --preview o script sai antes de renderizar (é o modo
    // de acertar a escala sem gastar minutos). Aqui queremos os dois — o frame
    // de comparação pra conferir e o vídeo pra usar. Tudo ffmpeg local.
    await run("python3", [...args, "--preview", preview]);
    await run("python3", args);

    const { publicUrl } = await uploadBuffer(await lerArquivo(saida), "composto.mp4", "video/mp4");
    const { publicUrl: previewUrl } = await uploadBuffer(await lerArquivo(preview), "preview.jpg", "image/jpeg");

    return {
      patch: { compostoUrl: publicUrl, previewUrl },
      pause: true,
      msg: `composto na escala ${e.escala} — compare o tamanho da cabeça no preview`,
    };
  });
