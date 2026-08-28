import { join } from "node:path";
import { escreverPromptClipe } from "../compartilhado/lib/casting";
import { uploadBuffer } from "../compartilhado/lib/storage";
import { writeFile as escreverArquivo } from "node:fs/promises";
import { baixar, comTemp, lerArquivo, run } from "../exec";
import { rodar } from "../wavespeed";
import { custoClipe, modeloDe } from "../compartilhado/lib/modelos-video";
import type { Job, StepResult } from "../tipos";

/**
 * O prompt do clipe: o escrito à mão manda; só se não houver é que a LLM é
 * chamada. Devolver o manual aqui é o que economiza a chamada — não adianta
 * gerar e descartar.
 */
const promptDoClipe = async (
  job: Job,
  alvo: { n: number; texto: string },
  total: number,
  formatoDialogo: string,
): Promise<string> => {
  const manual = (job.manifest.prompts ?? []).find((p) => p.n === alvo.n)?.prompt?.trim();
  if (manual) return manual;

  const { prompt } = await escreverPromptClipe({
    nota: job.manifest.casting?.nota ?? "",
    texto: alvo.texto,
    n: alvo.n,
    total,
    formatoDialogo,
  });
  return prompt;
};

/**
 * Extrai o último frame de um mp4 local e hospeda como PNG.
 *
 * O `-sseof -0.1` posiciona 0,1s antes do fim: pegar o frame exato do fim às
 * vezes cai num quadro sem imagem decodificável.
 */
const ultimoFrame = async (mp4: string, dir: string, paraClipe: number): Promise<string> => {
  const png = join(dir, `frame-${paraClipe}.png`);
  await run("ffmpeg", ["-y", "-v", "error", "-sseof", "-0.1", "-i", mp4, "-vframes", "1", png]);
  return (await uploadBuffer(await lerArquivo(png), `frame-${paraClipe}.png`, "image/png")).publicUrl;
};

/** Pro log dizer QUEM escreveu o prompt — depois do portão, todo clipe tem um. */
const origemDoPrompt = (job: Job, n: number) =>
  (job.manifest.prompts ?? []).find((p) => p.n === n)?.origem === "humano"
    ? " · prompt seu"
    : "";

/**
 * Gera UM clipe por execução e devolve o job pra fila.
 *
 * Um clipe por vez porque a cadeia é serial de qualquer forma — o clipe 2 nasce
 * do último frame do clipe 1 — e porque assim um clipe que falha não derruba os
 * que já foram pagos. O painel também mostra progresso de verdade.
 *
 * Só a versão B (voz gerada pelo próprio modelo de vídeo) sai por padrão: na
 * rodada de 24/08 o Gusta aprovou a B e rejeitou a A (lipsync da voz original).
 * Gerar as duas dobraria o custo pra entregar uma que ele já disse que não usa.
 *
 * Qual modelo gera o clipe é escolhido na criação da rodada; o adaptador de
 * entrada e o preço de cada um vivem em `src/lib/modelos-video.ts`.
 */
export const clipes = async (job: Job): Promise<StepResult> =>
  comTemp(async (dir) => {
    const modelo = modeloDe(job.manifest.modeloVideo);
    const roteiro = job.manifest.roteiro ?? [];
    if (!roteiro.length) throw new Error("sem roteiro — o passo anterior não rodou");

    const feitos = job.manifest.clipes ?? [];

    // Pedido de take alternativo vem na frente da fila normal: o Gusta está na
    // tela esperando pra comparar, e o take sai do MESMO frame de partida do
    // clipe original — é o que torna a comparação sobre o modelo, e não sobre a
    // imagem-base.
    const pedido = job.manifest.takePedido;
    if (pedido) {
      const alvo = roteiro.find((c) => c.n === pedido.n);
      if (!alvo) throw new Error(`take pedido pro clipe ${pedido.n}, que não existe no roteiro`);

      const partida = feitos.find((c) => c.n === pedido.n)?.startImage ?? job.manifest.imagemBaseUrl;
      if (!partida) throw new Error(`clipe ${pedido.n} sem imagem de partida — gere o clipe original antes`);

      const alt = modeloDe(pedido.modelo);
      const promptAlt = await promptDoClipe(job, alvo, roteiro.length, alt.formatoDialogo);

      const ra = await rodar(alt.id, alt.entrada({
        image: partida,
        prompt: promptAlt,
        promptNegativo: job.manifest.promptNegativo,
        duracao: alvo.duracao,
      }));

      const urlAlt = ra.outputs[0];
      if (!urlAlt) throw new Error(`take ${pedido.n}: ${alt.rotulo} não devolveu vídeo`);

      const bytesAlt = await (await fetch(urlAlt)).arrayBuffer();
      const up = await uploadBuffer(bytesAlt, `take-${pedido.n}-${pedido.modelo}.mp4`, "video/mp4");
      const custo = custoClipe(alt, alvo.duracao);

      return {
        patch: {
          // Um take por (clipe, modelo): pedir de novo substitui em vez de empilhar.
          takes: [
            ...(job.manifest.takes ?? []).filter((t) => !(t.n === pedido.n && t.modelo === pedido.modelo)),
            { n: pedido.n, modelo: pedido.modelo, url: up.publicUrl, jobId: ra.id, custoCents: custo },
          ].sort((a, b) => a.n - b.n || a.modelo.localeCompare(b.modelo)),
          takePedido: undefined,
        },
        // Fica no `clipes`. Sem isso o passo natural seguinte seria `montar`, e a
        // rodada avançaria pra montagem só por ter gerado um take de comparação.
        next: "clipes",
        // Para na tela: o take existe pra ser comparado no olho, não pra seguir sozinho.
        pause: true,
        costCents: custo,
        msg: `take do clipe ${pedido.n} no ${alt.rotulo}${origemDoPrompt(job, pedido.n)} — compare com o original`,
      };
    }

    const proximo = roteiro.find((c) => !feitos.find((f) => f.n === c.n && f.url));
    if (!proximo) return { msg: `${feitos.length} clipe(s) prontos` };

    // Encadeamento de identidade: o clipe 1 sai da imagem-base; do 2 em diante,
    // o start_image é o último frame do anterior. Sem isso cada clipe volta à
    // pose inicial e a emenda vira um salto visível.
    let startImage = job.manifest.imagemBaseUrl;
    if (proximo.n > 1) {
      const anterior = feitos.find((f) => f.n === proximo.n - 1);
      if (!anterior?.url) throw new Error(`clipe ${proximo.n - 1} sem vídeo — cadeia quebrada`);

      // O frame já foi extraído quando o clipe anterior nasceu, com os bytes em
      // mãos. Rodada começada antes dessa mudança não tem: aí baixa o clipe, que
      // agora vem em blocos.
      startImage = anterior.ultimoFrameUrl
        ?? await ultimoFrame(await baixar(anterior.url, join(dir, "anterior.mp4")), dir, proximo.n);
    }
    if (!startImage) throw new Error("sem imagem-base aprovada");

    // PORTÃO DE PROMPT. O prompt é escrito num tick e o vídeo é gerado no
    // seguinte, com uma parada no meio pra conferência.
    //
    // Antes, o prompt nascia e virava US$ 0,50-1,70 de vídeo na mesma volta: se
    // a LLM entendesse errado a fala ou perdesse a âncora de figurino, só dava
    // pra descobrir olhando o clipe já pago. Agora ele aparece na tela primeiro.
    //
    // Prompt escrito à mão não passa pelo portão — quem escreveu já conferiu.
    const definido = (job.manifest.prompts ?? []).find((p) => p.n === proximo.n)?.prompt?.trim();
    if (!definido) {
      const { prompt: proposto, enviado } = await escreverPromptClipe({
        nota: job.manifest.casting?.nota ?? "",
        texto: proximo.texto,
        n: proximo.n,
        total: roteiro.length,
        formatoDialogo: modelo.formatoDialogo,
      });

      return {
        patch: {
          prompts: [
            ...(job.manifest.prompts ?? []).filter((p) => p.n !== proximo.n),
            // `enviado` viaja junto: na hora de conferir, saber o que a LLM
            // RECEBEU é o que separa "ela interpretou mal" de "o insumo já
            // estava errado".
            { n: proximo.n, prompt: proposto, origem: "llm" as const, enviado },
          ].sort((a, b) => a.n - b.n),
        },
        // Continua no `clipes`: o passo não terminou, só parou pra conferência.
        next: "clipes",
        pause: true,
        msg: `prompt do clipe ${proximo.n}/${roteiro.length} pronto — confira antes de gerar no ${modelo.rotulo}`,
      };
    }

    const prompt = definido;

    const r = await rodar(modelo.id, modelo.entrada({
      image: startImage,
      prompt,
      promptNegativo: job.manifest.promptNegativo,
      duracao: proximo.duracao,
    }));

    const url = r.outputs[0];
    if (!url) throw new Error(`clipe ${proximo.n}: ${modelo.rotulo} não devolveu vídeo`);

    const bytes = await (await fetch(url)).arrayBuffer();
    const { publicUrl } = await uploadBuffer(bytes, `clipe-${proximo.n}.mp4`, "video/mp4");

    // O último frame sai AGORA, do arquivo que já está em mãos. Antes o próximo
    // tick rebaixava o clipe inteiro (24-37 MB) só pra pegar um quadro — e era
    // exatamente aí que a esteira travava quando o objeto vinha ruim do Storage.
    const local = join(dir, `clipe-${proximo.n}.mp4`);
    await escreverArquivo(local, Buffer.from(bytes));
    const frameUrl = await ultimoFrame(local, dir, proximo.n + 1);

    const atualizados = [
      ...feitos.filter((f) => f.n !== proximo.n),
      {
        n: proximo.n, url: publicUrl, jobId: r.id, startImage,
        modelo: job.manifest.modeloVideo, ultimoFrameUrl: frameUrl,
      },
    ].sort((a, b) => a.n - b.n);

    const restam = roteiro.length - atualizados.filter((c) => c.url).length;

    return {
      patch: { clipes: atualizados },
      // Volta pra fila enquanto sobrar clipe. O worker retoma no próximo tick.
      next: restam > 0 ? "clipes" : undefined,
      costCents: custoClipe(modelo, proximo.duracao),
      msg:
        `clipe ${proximo.n}/${roteiro.length} pronto no ${modelo.rotulo}${origemDoPrompt(job, proximo.n)}` +
        (restam ? ` · faltam ${restam}` : ""),
    };
  });
