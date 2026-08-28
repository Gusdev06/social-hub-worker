import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { uploadBuffer } from "../compartilhado/lib/storage";
import { baixar, comTemp, lerArquivo, run } from "../exec";
import { SCRIPTS } from "../caminhos";
import type { RenderEstrutura } from "../compartilhado/db/schema";
import type { Job, StepResult } from "../tipos";

const FPS = 30;

async function dimensoes(caminho: string): Promise<{ largura: number; altura: number }> {
  const s = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", caminho,
  ]);
  const [largura, altura] = s.trim().split(",").map(Number);
  return { largura, altura };
}

async function duracao(caminho: string): Promise<number> {
  const s = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", caminho,
  ]);
  return Number(s.trim());
}

/**
 * Costura os clipes num vídeo só.
 *
 * Antes de costurar, tira as pausas de cada clipe. O Kling deixa respiro morto
 * no começo e no fim de cada geração; somados, viram um vídeo arrastado que não
 * tem o ritmo do original. É local e custa zero.
 *
 * Reencoda tudo pra um alvo único antes do concat: o concat demuxer exige
 * parâmetros idênticos, e clipe gerado volta com fps e resolução variáveis —
 * concatenar sem normalizar produz áudio dessincronizado.
 */
/**
 * Onde termina a faixa do avatar depois que o original corta pro split screen.
 *
 * Lia `segmentos[0]` cegamente, e isso quebrava em qualquer referência que
 * COMEÇA em tela cheia: o segmento 0 tem uma faixa só, de altura total, e o
 * painel de baixo saía com 0px — `crop` com height '0' e ffmpeg abortando.
 *
 * O número certo vem do primeiro segmento DIVIDIDO, que é a geometria vigente
 * depois do corte. E só serve se o painel principal encostar no topo: quando o
 * original põe as barras de caption em cima (painel principal começando no meio
 * da tela), o modelo "avatar em cima" não descreve aquele layout — devolver 0
 * manda o `compor` entregar o talking head puro em vez de inventar geometria.
 */
function topoDoPainel(est?: RenderEstrutura): number {
  const dividido = est?.segmentos?.find((s) => s.layout === "dividido");
  const painel = dividido?.faixas?.find((f) => f.papel.includes("painel principal"));
  if (!painel || painel.y0 !== 0) return 0;
  // Faixa que ocupa a tela toda não é split screen, é tela cheia mal rotulada.
  return painel.y1 >= (est?.altura ?? Infinity) ? 0 : painel.y1;
}

type Faixa = { y0: number; y1: number; fonte: "avatar" | "ref" };
type Trecho = { ini_av: number; fim_av: number; ini_ref: number; fim_ref: number; faixas: Faixa[] };

/**
 * A receita de remontagem, tirada da análise — sem layout fixo.
 *
 * Cada segmento medido vira um trecho com a PILHA DE FAIXAS daquele momento. A
 * faixa rotulada "painel principal" é a pessoa, e é a única que o avatar
 * substitui; todas as outras (caption, b-roll, screen recording) são
 * reaproveitadas do original. Tela cheia é só o caso de uma faixa só.
 *
 * O modelo anterior era um corte único — dividido até X, tela cheia depois — e
 * não conseguia expressar criativo que abre em tela cheia, que alterna, ou que
 * põe a caption em cima com a pessoa embaixo.
 */
function planoDeRemontagem(est: RenderEstrutura, duracaoAvatar: number): Trecho[] {
  const segs = est.segmentos ?? [];
  if (!segs.length || !est.duracao || !duracaoAvatar) return [];

  // O avatar reconta o mesmo roteiro em outra duração; as fronteiras da edição
  // são reescaladas na mesma proporção pra continuarem caindo na mesma fala.
  const fator = duracaoAvatar / est.duracao;

  const trechos = segs.map((s, i) => {
    const ordenadas = [...(s.faixas ?? [])].sort((a, b) => a.y0 - b.y0);

    // As faixas medidas nem sempre ladrilham o quadro (a última do criativo do
    // Gusta começa em y40, deixando 40px órfãos no topo). A remontagem precisa
    // cobrir a tela inteira, então as fronteiras são esticadas: cada faixa vai
    // até onde a próxima começa, a primeira começa em 0 e a última fecha embaixo.
    const principais = ordenadas.filter((f) => f.papel.includes("painel principal"));
    const faixas: Faixa[] =
      ordenadas.length && principais.length === 1
        ? ordenadas.map((f, n) => ({
            y0: n === 0 ? 0 : ordenadas[n].y0,
            y1: n === ordenadas.length - 1 ? est.altura : ordenadas[n + 1].y0,
            fonte: f === principais[0] ? ("avatar" as const) : ("ref" as const),
          }))
        // Sem um "painel principal" claro não dá pra saber qual faixa é a pessoa.
        // Entregar o avatar em tela cheia é honesto; inventar geometria não é.
        : [{ y0: 0, y1: est.altura, fonte: "avatar" as const }];

    return {
      ini_av: i === 0 ? 0 : s.inicio * fator,
      fim_av: i === segs.length - 1 ? duracaoAvatar : s.fim * fator,
      ini_ref: s.inicio,
      fim_ref: s.fim,
      faixas,
    };
  });

  // Trechos vizinhos com a MESMA pilha viram um só: menos nós no filtro do
  // ffmpeg e menos emendas de concat, sem mudar uma linha do resultado.
  return trechos.reduce<Trecho[]>((acc, t) => {
    const ult = acc.at(-1);
    const igual = ult && JSON.stringify(ult.faixas) === JSON.stringify(t.faixas);
    if (igual) { ult!.fim_av = t.fim_av; ult!.fim_ref = t.fim_ref; return acc; }
    return [...acc, t];
  }, []);
}

export const montar = async (job: Job): Promise<StepResult> =>
  comTemp(async (dir) => {
    const clipes = (job.manifest.clipes ?? []).filter((c) => c.url).sort((a, b) => a.n - b.n);
    if (!clipes.length) throw new Error("nenhum clipe pra montar");

    const est = job.manifest.estrutura;

    // O alvo é a resolução NATIVA dos clipes (o Kling entrega 1080x1920), nunca
    // a da referência. O criativo de referência costuma ser um rip da Ad
    // Library em 360x640 — ele é referência de LAYOUT, não asset. Normalizar
    // por ele jogava 9x os pixels fora e deixava o avatar minúsculo na
    // composição, que é renderizada em 1080 de largura.
    const primeiro = await baixar(clipes[0].url!, join(dir, "medir.mp4"));
    const { largura, altura } = await dimensoes(primeiro);

    const normalizados: string[] = [];
    let duracaoClipe1 = 0;

    for (const c of clipes) {
      const bruto = await baixar(c.url!, join(dir, `bruto-${c.n}.mp4`));

      const fluido = join(dir, `fluido-${c.n}.mp4`);
      await run("python3", [join(SCRIPTS, "remover_pausas.py"), bruto, fluido]);

      const alvo = join(dir, `norm-${c.n}.mp4`);
      const vf =
        `scale=${largura}:${altura}:force_original_aspect_ratio=decrease,` +
        `pad=${largura}:${altura}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},setsar=1`;
      await run("ffmpeg", [
        "-y", "-v", "error", "-i", fluido, "-vf", vf,
        "-c:v", "libx264", "-crf", "20", "-preset", "medium",
        "-c:a", "aac", "-ar", "44100", "-ac", "2", alvo,
      ]);

      normalizados.push(alvo);
      if (c.n === clipes[0].n) duracaoClipe1 = await duracao(alvo);
    }

    const lista = join(dir, "lista.txt");
    await writeFile(lista, normalizados.map((f) => `file '${f}'`).join("\n"), "utf8");

    const saida = join(dir, "versao-B.mp4");
    await run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lista, "-c", "copy", saida]);

    const { publicUrl } = await uploadBuffer(await lerArquivo(saida), "versao-B-voz-kling.mp4", "video/mp4");
    const total = await duracao(saida);


    // Onde termina a parte dividida.
    //
    // Quando o original corta pra tela cheia, é no primeiro corte de layout — e
    // no vídeo novo o equivalente é o fim do clipe 1, porque é ali que a fala
    // muda de frase. (Tirar as pausas muda essa duração, então ela só pode ser
    // lida DEPOIS da fluidificação.)
    //
    // Mas tem criativo que é split screen do começo ao fim e nunca vira tela
    // cheia: ele tem faixas e ZERO corte de layout. Aí a parte dividida é o
    // vídeo inteiro. Ler "sem corte" como "sem edição" fazia a composição ser
    // pulada e entregava o talking head pelado.
    const temCorte = (est?.cortes?.length ?? 0) > 0;

    return {
      patch: {
        versaoBUrl: publicUrl,
        edicao: {
          topo: topoDoPainel(est),
          corteRef: temCorte ? est!.cortes[0] : (est?.duracao ?? 0),
          corte: Number((temCorte ? duracaoClipe1 : total).toFixed(3)),
          escala: job.manifest.edicao?.escala ?? 0.7,
          trechos: est ? planoDeRemontagem(est, total) : undefined,
        },
      },
      msg:
        `${clipes.length} clipe(s) costurados · ${largura}x${altura} · ` +
        `${total.toFixed(1)}s · corte em ${duracaoClipe1.toFixed(2)}s`,
    };
  });
