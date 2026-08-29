import { escreverCasting } from "../compartilhado/lib/casting";
import { uploadBuffer } from "../compartilhado/lib/storage";
import { CUSTO_CENTS, rodar } from "../wavespeed";
import type { Job, StepResult } from "../tipos";

/** O gerador do rosto novo. */
const MODELO_IMAGEM = "openai/gpt-image-2/text-to-image";

const NEGATIVO =
  "studio lighting, beauty retouching, poreless skin, plastic skin, oversharpened, " +
  "symmetrical lighting, stock photo look, visible hands, extra fingers, watermark, " +
  "text overlay, oversaturated";

/**
 * Os ratios que o GPT Image 2 aceita. Ele valida contra esta lista — mandar o
 * ratio exato do original (um rip de 360x854 daria "180:427") volta erro do
 * provedor, então a medida vira o VIZINHO mais próximo daqui.
 */
const RATIOS = [
  "1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2",
  "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:21", "21:9",
] as const;

/** 1080x1920 → "9:16". O ratio da base tem que ser o do original. */
function ratioDe(l = 1080, a = 1920): string {
  const alvo = l / a;
  return RATIOS.reduce((melhor, r) => {
    const [x, y] = r.split(":").map(Number);
    const dist = Math.abs(x / y - alvo);
    const [bx, by] = melhor.split(":").map(Number);
    return dist < Math.abs(bx / by - alvo) ? r : melhor;
  }, "9:16" as string);
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

  // `quality` fica no padrão do provedor (medium) de propósito: alto multiplica
  // o preço e o que decide a aprovação do rosto aqui é o casting, não o pixel.
  const img = await rodar(MODELO_IMAGEM, {
    prompt: casting.prompt,
    aspect_ratio: ratio,
    resolution: "2k",
    output_format: "png",
  });

  const url = img.outputs[0];
  if (!url) throw new Error(`${MODELO_IMAGEM} não devolveu imagem`);

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
    costCents: CUSTO_CENTS[MODELO_IMAGEM],
    msg: `rosto gerado em ${ratio} — aprove antes de queimar crédito de vídeo`,
  };
};
