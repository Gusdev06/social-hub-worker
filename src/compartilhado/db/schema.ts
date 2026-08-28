import {
  pgTable, text, timestamp, boolean, integer, real, jsonb, uuid, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import type { ModeloVideoKey } from "../lib/modelos-video";

/**
 * Multi-tenant-ready: hoje só existe um workspace (o do Gusta), mas todas as
 * tabelas de negócio penduram em workspaceId. Quando/se virar SaaS, é só
 * popular a tabela e trocar o workspace fixo por sessão de usuário.
 */
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Um perfil conectado (um @ do Instagram ou do TikTok). */
export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: ["instagram", "tiktok"] }).notNull(),

    /** ig-user-id (IG) ou open_id (TikTok). */
    externalId: text("external_id").notNull(),
    username: text("username").notNull(),
    /** Requisito DURO da auditoria do TikTok: exibir avatar+username antes de postar. */
    avatarUrl: text("avatar_url"),

    /** Cifrados em repouso — ver src/lib/crypto.ts. Nunca logar. */
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("social_accounts_platform_external_idx").on(t.platform, t.externalId),
    index("social_accounts_expiry_idx").on(t.tokenExpiresAt),
  ],
);

/** Uma regra comentário → DM. */
export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => socialAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),

    /**
     * specific = só nos posts escolhidos · any = qualquer post ·
     * next = só nos posts publicados a partir de agora.
     */
    triggerScope: text("trigger_scope", { enum: ["specific", "any", "next"] })
      .default("specific").notNull(),
    /** null = vale pra qualquer post da conta. Preenchido = só naquele media. */
    mediaId: text("media_id"),
    /** Vários posts selecionados no wizard (triggerScope = specific). */
    mediaIds: jsonb("media_ids").$type<string[]>().default([]).notNull(),
    /** Só dispara em posts criados depois disto (triggerScope = next). */
    activeFrom: timestamp("active_from", { withTimezone: true }),
    keywords: jsonb("keywords").$type<string[]>().default([]).notNull(),
    matchMode: text("match_mode", { enum: ["exact", "contains"] }).default("contains").notNull(),

    /**
     * PASSO 1 do DM — a mensagem de boas-vindas. Vai com um botão de postback:
     * o Instagram exige que a pessoa TOQUE antes de receber link, e quem toca
     * converte muito melhor do que quem só recebe link na cara.
     */
    dmMessage: text("dm_message").notNull(),
    welcomeButtonLabel: text("welcome_button_label").default("Me envie o link").notNull(),

    /** PASSO 2 — enviado depois que a pessoa toca no botão de boas-vindas. */
    followUpMessage: text("follow_up_message"),
    followUpButtons: jsonb("follow_up_buttons")
      .$type<{ title: string; url: string }[]>().default([]).notNull(),

    /** Compatibilidade: botões na própria mensagem de boas-vindas. */
    dmButtons: jsonb("dm_buttons").$type<{ title: string; url: string }[]>().default([]).notNull(),
    /** Resposta pública opcional no comentário ("te mandei no DM 👀"). */
    publicReply: text("public_reply"),
    /** Curte/responde os comentários da pessoa no post. */
    replyToComments: boolean("reply_to_comments").default(false).notNull(),

    /** Contadores pra métrica da lista. CTR = clicks / executions. */
    executions: integer("executions").default(0).notNull(),
    clicks: integer("clicks").default(0).notNull(),

    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("automations_account_active_idx").on(t.accountId, t.isActive)],
);

/**
 * Fila durável + trava de idempotência.
 * O IG permite exatamente UM private reply por comentário (2º retorna subcode
 * 2534014), então commentId é UNIQUE: o insert é a própria trava de corrida.
 */
export const commentEvents = pgTable(
  "comment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => socialAccounts.id, { onDelete: "cascade" }),

    commentId: text("comment_id").notNull(),
    mediaId: text("media_id").notNull(),
    fromUserId: text("from_user_id").notNull(),
    fromUsername: text("from_username"),
    text: text("text").notNull(),

    status: text("status", {
      enum: ["pending", "processing", "sent", "skipped", "failed"],
    }).default("pending").notNull(),
    automationId: uuid("automation_id").references(() => automations.id, { onDelete: "set null" }),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),

    /** Private reply só vale por 7 dias após o comentário — depois expira. */
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("comment_events_comment_id_idx").on(t.commentId),
    index("comment_events_sweep_idx").on(t.status, t.receivedAt),
  ],
);

/**
 * O ativo real da plataforma. A automação é commodity; a base de contatos
 * capturada é o que o ManyChat cobra caro pra te devolver.
 */
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => socialAccounts.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: ["instagram", "tiktok"] }).notNull(),

    externalUserId: text("external_user_id").notNull(),
    username: text("username"),

    sourceAutomationId: uuid("source_automation_id").references(() => automations.id, { onDelete: "set null" }),
    sourceMediaId: text("source_media_id"),
    /** Quantas vezes esse contato já entrou por alguma automação. */
    touchCount: integer("touch_count").default(1).notNull(),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("leads_account_user_idx").on(t.accountId, t.externalUserId)],
);

/** Um post lógico, agendado uma vez e espalhado para N perfis. */
export const scheduledPosts = pgTable(
  "scheduled_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),

    caption: text("caption").notNull(),
    /** A Content Publishing API do IG exige URL pública — não aceita upload direto. */
    mediaUrls: jsonb("media_urls").$type<string[]>().default([]).notNull(),
    mediaType: text("media_type", { enum: ["image", "video", "carousel", "reel"] }).notNull(),

    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["draft", "scheduled", "publishing", "done", "failed"] })
      .default("draft").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("scheduled_posts_due_idx").on(t.status, t.scheduledFor)],
);

/** Fan-out: uma linha por (post × perfil de destino). Falha isolada por conta. */
export const postTargets = pgTable(
  "post_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduledPostId: uuid("scheduled_post_id").notNull().references(() => scheduledPosts.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull().references(() => socialAccounts.id, { onDelete: "cascade" }),

    status: text("status", { enum: ["pending", "publishing", "done", "failed"] })
      .default("pending").notNull(),
    externalPostId: text("external_post_id"),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("post_targets_post_account_idx").on(t.scheduledPostId, t.accountId)],
);

/* ────────────────────────────────────────────────────────────────────────────
   PRODUÇÃO DE VÍDEO — clonar um criativo campeão trocando o avatar.

   Uma rodada leva 10~15 min e é ENCADEADA (o clipe 2 nasce do último frame do
   clipe 1), então não cabe em nenhum timeout de função. O padrão é o mesmo que
   já resolveu o webhook de comentário: o banco é a fila, e um worker externo
   avança UM passo por vez. Cada passo é retomável — se o worker morre no meio
   do clipe 2, ele volta e refaz só o clipe 2.

   O ffmpeg e o numpy não rodam em serverless, por isso o worker é um container
   separado (ver worker/README.md) que consulta esta mesma tabela.
   ──────────────────────────────────────────────────────────────────────────── */

/** Os passos da esteira, na ordem. O worker executa `step` e avança pro próximo. */
export const RENDER_STEPS = [
  "analisar",   // mede faixas e cortes do original (ffmpeg + numpy)
  "roteiro",    // transcreve e fatia em clipes de 55-60 sílabas
  "imagem_base",// gera o rosto novo — pausa pra aprovação humana
  "clipes",     // Kling, um clipe por tick, encadeando o último frame
  "montar",     // costura os clipes + lipsync da voz original
  "compor",     // remonta a edição do original (split screen) por cima
  "publicar",   // vira scheduled_post e cai no fan-out multi-perfil
] as const;
export type RenderStep = (typeof RENDER_STEPS)[number];

/** Saída literal do `analisar_estrutura.py` — medida, não chute. */
export type RenderEstrutura = {
  largura: number;
  altura: number;
  fps: number;
  duracao: number;
  cortes: number[];
  cortes_de_conteudo_descartados: number[];
  segmentos: {
    inicio: number;
    fim: number;
    duracao: number;
    layout: "dividido" | "tela cheia";
    faixas: {
      y0: number; y1: number; altura: number; fracao: number;
      desvio_horizontal: number; vermelhidao: number; papel: string;
    }[];
  }[];
};

/**
 * O manifesto acumulado da rodada. É o mesmo `manifest.json` que a operação já
 * usa no disco — e é o que permite regerar UM clipe fraco sem refazer a rodada.
 * Cresce a cada passo; nenhum passo apaga o que o anterior escreveu.
 */
export type RenderManifest = {
  estrutura?: RenderEstrutura;                          // saída de analisar_estrutura.py
  /** Um frame por segmento, pra confirmar no olho o palpite estatístico das faixas. */
  frames?: { segmento: number; t: number; url: string }[];
  roteiro?: { n: number; texto: string; silabas: number; duracao: number }[];
  /** Roteiro corrigido à mão — quando presente, manda sobre a transcrição. */
  roteiroManual?: string;
  /** O texto efetivamente fatiado, pra editar sem re-transcrever. */
  roteiroTexto?: string;
  /**
   * Qual modelo de vídeo gera os clipes. Escolhido na criação da rodada e fixo
   * dali em diante: trocar no meio deixaria clipes de modelos diferentes na
   * mesma emenda, e a cadeia de identidade (cada clipe nasce do último frame do
   * anterior) não sobrevive a isso. Ausente = rodada antiga, feita no Kling.
   */
  modeloVideo?: ModeloVideoKey;
  /**
   * O prompt DE REGISTRO de cada clipe — o texto que vai mesmo pro modelo de
   * vídeo. Enquanto não existir, a esteira não gera: ela escreve a proposta,
   * grava aqui e para pra conferência.
   *
   * `origem` distingue quem escreveu. Sem isso o log diria "prompt manual" pra
   * todo clipe, já que depois do portão todos passam por aqui.
   *   - `llm`    — proposto pelo escritor de prompt, ainda a conferir ou já aceito
   *   - `humano` — escrito ou corrigido pelo Gusta; não passa pelo portão de novo
   */
  prompts?: {
    n: number;
    prompt: string;
    origem: "llm" | "humano";
    /**
     * A conversa que produziu este prompt: o que foi mandado pra LLM e por qual
     * modelo. Guardado pra conferência — quando o prompt sai estranho, a
     * pergunta é se a LLM interpretou mal ou se o insumo já chegou errado
     * (nota de casting vazia, fala fatiada no lugar errado). Ausente quando o
     * prompt foi escrito à mão: aí não houve conversa.
     */
    enviado?: { sistema: string; usuario: string; modelo: string };
  }[];
  casting?: { nota: string; promptBase?: string };
  audioOriginalUrl?: string;
  imagemBaseUrl?: string;
  imagensDescartadas?: string[];                        // rostos reprovados, pra não repetir
  promptNegativo?: string;
  clipes?: {
    n: number; url?: string; jobId?: string; startImage?: string; modelo?: ModeloVideoKey;
    /**
     * Último frame deste clipe, já extraído e hospedado — é o `start_image` do
     * próximo. Guardado porque extrair custa nada na hora em que os bytes ainda
     * estão na memória, e custa um download de 24-37 MB depois.
     */
    ultimoFrameUrl?: string;
  }[];
  /**
   * Takes alternativos do mesmo clipe, em outros modelos, pra comparar antes de
   * escolher. Ficam FORA de `clipes` — só entram lá quando promovidos, senão a
   * montagem costuraria dois takes do mesmo trecho.
   */
  takes?: { n: number; modelo: ModeloVideoKey; url: string; jobId?: string; custoCents: number }[];
  /** Pedido de take pendente. O painel marca, o worker executa e limpa. */
  takePedido?: { n: number; modelo: ModeloVideoKey };
  videoMudoUrl?: string;
  versaoAUrl?: string;                                  // voz original (lipsync)
  versaoBUrl?: string;                                  // voz do Kling
  compostoUrl?: string;                                 // com a edição do original
  previewUrl?: string;                                  // comparação lado a lado com a referência
  scheduledPostId?: string;
  edicao?: {
    topo: number; corteRef: number; corte: number; escala: number;
    /**
     * A receita de remontagem: um trecho por segmento medido no original, cada
     * um com a PILHA DE FAIXAS daquele momento. `fonte: "avatar"` é a faixa da
     * pessoa (a que trocamos); `"ref"` é reaproveitada do criativo original.
     *
     * Não há layout fixo: avatar em cima, caption em cima com a pessoa embaixo,
     * três faixas ou tela cheia são todos a mesma estrutura com pilhas
     * diferentes. `topo`/`corte`/`corteRef` acima são o modelo antigo de um
     * corte só, mantidos pra rodada começada antes disso.
     */
    trechos?: {
      ini_av: number; fim_av: number; ini_ref: number; fim_ref: number;
      faixas: { y0: number; y1: number; fonte: "avatar" | "ref" }[];
    }[];
  };
  log?: { at: string; step: string; msg: string }[];
};

export const renderJobs = pgTable(
  "render_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    /** URL pública do criativo de referência (Supabase Storage). */
    refVideoUrl: text("ref_video_url").notNull(),
    /** Descrição do avatar novo — vira a nota de casting. */
    castingBrief: text("casting_brief"),

    step: text("step", { enum: RENDER_STEPS }).default("analisar").notNull(),
    status: text("status", {
      enum: ["pending", "running", "waiting_approval", "done", "failed", "canceled"],
    }).default("pending").notNull(),

    manifest: jsonb("manifest").$type<RenderManifest>().default({}).notNull(),

    /**
     * Lease do worker. Sem isso, dois workers pegariam o mesmo job e gastariam
     * crédito de Kling em dobro. `lockedAt` velho = worker morreu, pode retomar.
     */
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),

    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    /** Custo real acumulado, em centavos de dólar. Vídeo é caro; tem que aparecer. */
    costCents: integer("cost_cents").default(0).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("render_jobs_claim_idx").on(t.status, t.lockedAt)],
);

/**
 * Sinal de vida do worker.
 *
 * O worker roda na máquina do Gusta, não num container. Sem esse sinal, uma
 * rodada criada com o Mac desligado fica parada em "na fila" sem explicação —
 * e o painel estaria mentindo. Com ele, a tela diz na cara que o executor está
 * fora e o que fazer.
 */
export const workerHeartbeat = pgTable("worker_heartbeat", {
  id: text("id").primaryKey(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  /** Último passo que ele tocou — ajuda a saber se está vivo mas travado. */
  ultimoPasso: text("ultimo_passo"),
});

/**
 * Os vídeos prontos — o acervo, separado da fila.
 *
 * `render_jobs` é descartável: quando a fila enche de teste ela é limpa, e isso
 * levava junto o histórico do que foi produzido. Os arquivos continuavam no
 * Storage sem nada apontando pra eles. Aqui o vídeo sobrevive à rodada que o
 * gerou — por isso `jobId` não tem chave estrangeira.
 */
export const videos = pgTable(
  "videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** A rodada que o produziu. Sem FK: ela pode ser apagada e o vídeo fica. */
    jobId: uuid("job_id"),
    nome: text("nome").notNull(),
    url: text("url").notNull(),
    previewUrl: text("preview_url"),
    /** O criativo de referência, pra comparar lado a lado depois. */
    refVideoUrl: text("ref_video_url"),
    /** Qual modelo gerou os clipes — é o dado do teste. */
    modelo: text("modelo"),
    duracaoS: real("duracao_s"),
    custoCents: integer("custo_cents").default(0).notNull(),
    criadoEm: timestamp("criado_em", { withTimezone: true }).defaultNow().notNull(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("videos_recentes_idx").on(t.criadoEm)],
);
