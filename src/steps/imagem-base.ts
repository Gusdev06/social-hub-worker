import { escreverCasting } from "../compartilhado/lib/casting";
import { uploadBuffer } from "../compartilhado/lib/storage";
import { CUSTO_CENTS, rodar } from "../wavespeed";
import type { Job, StepResult } from "../tipos";

const NEGATIVO =
  "studio lighting, beauty retouching, poreless skin, plastic skin, oversharpened, " +
  "symmetrical lighting, stock photo look, visible hands, extra fingers, watermark, " +
  "text overlay, oversaturated";

/** 1080x1920 → "9:16". O ratio da base tem que ser o do original. */
function ratioDe(l = 1080, a = 1920): string {
  const d = (x: number, y: number): number => (y ? d(y, x % y) : x);
  const g = d(l, a);
  return `${l / g}:${a / g}`;
}

/**
 * Gera o rosto novo e PARA pra aprovação.
 *
 * Imagem custa centavos, vídeo custa dólar: um rosto errado aprovado aqui
 * custa a rodada inteira de clipes lá na frente. Por isso este passo sempre
 * pausa, mesmo quando a imagem sai boa de primeira.
 */
export const imagemBase = async (job: Job): Promise<StepResult> => {
  // Avatar reusado: a rodada já nasceu com o rosto e a nota de casting vindos do
  // acervo. Gerar aqui daria uma pessoa DIFERENTE por cima da que foi escolhida
  // — e ainda cobraria por isso. Pausa mesmo assim, porque a aprovação do rosto
  // é o portão que protege o crédito de vídeo lá na frente.
  if (job.manifest.imagemBaseUrl && job.manifest.casting?.nota) {
    return {
      pause: true,
      msg: "avatar reusado do acervo — confirme e siga",
    };
  }

  const est = job.manifest.estrutura;
  const ratio = est ? ratioDe(est.largura, est.altura) : "9:16";

  const brief = job.castingBrief?.trim();
  if (!brief) throw new Error("sem descrição do avatar — preencha o casting da rodada");

  const casting = await escreverCasting({
    brief,
    frameUrl: job.manifest.frames?.[0]?.url,
    ratio,
  });

  const img = await rodar("bytedance/seedream-v5.0-pro", {
    prompt: casting.prompt,
    aspect_ratio: ratio,
    resolution: "2k",
    output_format: "png",
  });

  const url = img.outputs[0];
  if (!url) throw new Error("seedream não devolveu imagem");

  // Rehospeda no nosso Storage: a URL do provedor expira, e a imagem-base é a
  // âncora de identidade de todos os clipes da rodada.
  const bytes = await (await fetch(url)).arrayBuffer();
  const { publicUrl } = await uploadBuffer(bytes, "avatar-base.png", "image/png");

  // O rosto anterior fica registrado — reprovar e regerar não pode perder o
  // histórico do que já foi descartado.
  const descartadas = [
    ...(job.manifest.imagensDescartadas ?? []),
    ...(job.manifest.imagemBaseUrl ? [job.manifest.imagemBaseUrl] : []),
  ];

  return {
    patch: {
      casting: { nota: casting.nota, promptBase: casting.prompt },
      imagemBaseUrl: publicUrl,
      imagensDescartadas: descartadas,
      promptNegativo: NEGATIVO,
    },
    pause: true,
    costCents: CUSTO_CENTS["bytedance/seedream-v5.0-pro"],
    msg: `rosto gerado em ${ratio} — aprove antes de queimar crédito de vídeo`,
  };
};
