/**
 * Os modelos de vídeo que a esteira sabe usar.
 *
 * **Só entra modelo com áudio nativo.** A esteira depende de a VOZ vir dentro do
 * clipe: o `montar` corta as pausas *da fala* e o `compor` remonta o split screen
 * em cima desse tempo. Um modelo mudo entregaria boca mexendo sem som e quebraria
 * os dois passos seguintes. (Os modelos de vídeo do namespace `minimax/` — Hailuo
 * 2.3 e 02 — caem nesse caso e por isso não estão aqui; o MiniMax H3 abaixo é
 * outro modelo, servido pelo WaveSpeed, e esse tem áudio.)
 *
 * Cada fornecedor nomeia as coisas do seu jeito — o Kling chama `sound`, o Wan
 * chama `enable_audio`, o H3 gera áudio sempre; o Kling aceita prompt negativo e
 * `cfg_scale`, os outros dois não aceitam nenhum dos dois. Esse adaptador mora
 * aqui, junto do preço, em vez de espalhado por `if (modelo === ...)` no passo
 * `clipes`.
 */

export type EntradaClipe = {
  /** Primeiro frame: a imagem-base no clipe 1, o último frame do anterior nos demais. */
  image: string;
  prompt: string;
  promptNegativo?: string;
  duracao: number;
};

export type ModeloVideo = {
  /** Id no WaveSpeed. */
  id: string;
  rotulo: string;
  /** Uma linha na tela, pro Gusta escolher sem abrir o catálogo. */
  nota: string;
  /**
   * Preço em centavos de dólar POR SEGUNDO de clipe.
   *
   * Os três cobram por segundo, não por clipe. O código antigo tinha um valor
   * fixo por clipe (56) calibrado em 5s, o que contava metade do custo de um
   * clipe de 10s no painel.
   */
  centsPorSegundo: number;
  /** Resolução que o clipe sai — o `montar` normaliza a composição por ela. */
  saida: string;
  durMin: number;
  durMax: number;
  /**
   * Como o modelo espera receber a fala. Vai pro escritor de prompt em vez de
   * ele assumir a convenção do Kling pra todo mundo.
   */
  formatoDialogo: string;
  entrada: (e: EntradaClipe) => Record<string, unknown>;
};

const clamp = (s: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(s)));

export const MODELOS_VIDEO = {
  "kling-3.0": {
    id: "kwaivgi/kling-v3.0-pro/image-to-video",
    rotulo: "Kling 3.0 Pro",
    nota: "o padrão da casa — melhor aderência ao prompt e ao rosto entre clipes; o único que aceita prompt negativo",
    centsPorSegundo: 11.2,
    saida: "1080×1920",
    durMin: 3,
    durMax: 15,
    formatoDialogo: '[Speaker, tom]: "fala literal"',
    entrada: ({ image, prompt, promptNegativo, duracao }) => ({
      image,
      prompt,
      negative_prompt: promptNegativo,
      duration: clamp(duracao, 3, 15),
      sound: true,
      // 0.45 dá folga pro modelo manter o rosto entre clipes; acima disso ele
      // obedece o texto e perde a pessoa na emenda.
      cfg_scale: 0.45,
    }),
  },
  "wan-3.0": {
    id: "alibaba/wan-3.0/image-to-video",
    rotulo: "Wan 3.0",
    nota: "um pouco mais barato que o Kling; 1080p existe mas dobra o preço, então sai em 720p",
    centsPorSegundo: 10,
    saida: "720×1280",
    durMin: 2,
    durMax: 30,
    formatoDialogo: "a fala entre aspas, precedida de quem diz e em que tom",
    entrada: ({ image, prompt, duracao }) => ({
      image,
      prompt,
      // O fatiador do roteiro corta em 3–15s (teto do Kling) pra que o MESMO
      // roteiro sirva aos três modelos — comparar modelos no mesmo criativo só é
      // honesto se o corte for idêntico. O teto de 30s do Wan sobra de propósito.
      duration: clamp(duracao, 2, 30),
      resolution: "720p",
      aspect_ratio: "9:16",
      enable_audio: true,
      // O otimizador reescreve a fala, e a fala é o ativo testado do criativo.
      enable_prompt_expansion: false,
    }),
  },
  "minimax-h3": {
    id: "wavespeed-ai/minimax-h3/image-to-video",
    rotulo: "MiniMax H3",
    nota: "o mais barato dos três (~30% abaixo do Kling), áudio estéreo nativo; sai em 768p, então a composição fica menor",
    centsPorSegundo: 8,
    saida: "768×1365",
    durMin: 3,
    durMax: 15,
    formatoDialogo: "a fala entre aspas dentro da descrição da cena — o áudio nasce junto do vídeo",
    entrada: ({ image, prompt, duracao }) => ({
      image,
      prompt,
      // 768p é a tela nativa do modelo; 480p custa metade mas o avatar é o único
      // asset novo do criativo — não é onde economizar.
      resolution: "768p",
      duration: clamp(duracao, 3, 15),
    }),
  },
} satisfies Record<string, ModeloVideo>;

export type ModeloVideoKey = keyof typeof MODELOS_VIDEO;
export const MODELO_PADRAO: ModeloVideoKey = "kling-3.0";

export const ehModeloVideo = (v: unknown): v is ModeloVideoKey =>
  typeof v === "string" && Object.hasOwn(MODELOS_VIDEO, v);

/** Rodada antiga não tem modelo no manifesto: cai no Kling, que é o que ela usou. */
export const modeloDe = (m?: string): ModeloVideo =>
  MODELOS_VIDEO[ehModeloVideo(m) ? m : MODELO_PADRAO];

/** Custo real de um clipe, em centavos — todos cobram por segundo. */
export const custoClipe = (m: ModeloVideo, duracao: number): number =>
  Math.round(m.centsPorSegundo * clamp(duracao, m.durMin, m.durMax));
