import { StorageClient } from "@supabase/storage-js";

const BUCKET = "media";

function client(): StorageClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configuradas — upload indisponível.",
    );
  }
  return new StorageClient(`${url.replace(/\/$/, "")}/storage/v1`, {
    apikey: key,
    Authorization: `Bearer ${key}`,
  });
}

export function storageConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Caminho unico e previsivel, sem depender do nome original do arquivo. */
function buildPath(fileName: string, stamp: number, rand: string): string {
  const ext = (fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
  const dia = new Date(stamp).toISOString().slice(0, 10);
  return `${dia}/${stamp}-${rand}${ext}`;
}

/**
 * Gera uma URL assinada pra o NAVEGADOR enviar o arquivo direto ao Supabase.
 * O arquivo nunca passa pela função da Vercel — que tem teto de ~4,5 MB de
 * corpo de request e derrubaria qualquer vídeo.
 */
export async function createSignedUpload(
  fileName: string,
): Promise<{ signedUrl: string; publicUrl: string; path: string }> {
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  const path = buildPath(fileName, stamp, rand);

  const { data, error } = await client().from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(error?.message ?? "falha ao assinar upload");

  const { data: pub } = client().from(BUCKET).getPublicUrl(path);

  return { signedUrl: data.signedUrl, publicUrl: pub.publicUrl, path };
}

/**
 * Upload direto do servidor. O caminho assinado acima existe pro navegador
 * (que não pode ver a service role); o worker roda no backend e sobe o
 * arquivo ele mesmo — frames de referência, clipes, o vídeo final.
 */
export async function uploadBuffer(
  data: Uint8Array | ArrayBuffer,
  fileName: string,
  contentType: string,
): Promise<{ publicUrl: string; path: string }> {
  const path = buildPath(fileName, Date.now(), Math.random().toString(36).slice(2, 10));

  const { error } = await client()
    .from(BUCKET)
    .upload(path, data, { contentType, upsert: true });
  if (error) throw new Error(error.message);

  const { data: pub } = client().from(BUCKET).getPublicUrl(path);
  await conferirCauda(pub.publicUrl, tamanho(data));
  return { publicUrl: pub.publicUrl, path };
}

const tamanho = (d: Uint8Array | ArrayBuffer) =>
  d instanceof ArrayBuffer ? d.byteLength : d.byteLength;

/** Acima disso vale conferir; abaixo, o custo da checagem não se paga. */
const GRANDE = 8 * 1024 * 1024;

/**
 * Confere que o objeto recém-subido é LEGÍVEL ATÉ O FIM.
 *
 * Em 27/08 um clipe de 23,9 MB subiu "com sucesso" e ficou servindo só os
 * primeiros ~18,7 MB: os blocos do começo vinham a 8 MB/s e os do fim estagnavam
 * pra sempre. A esteira só descobria isso no passo seguinte, como timeout, e o
 * clipe já estava pago.
 *
 * Conferir tamanho não adianta — o objeto quebrado reportava `content-length`
 * certo. O que expõe o defeito é PEDIR os últimos bytes, que é o que isto faz.
 */
async function conferirCauda(url: string, total: number): Promise<void> {
  if (total < GRANDE) return;

  const inicio = Math.max(0, total - 64 * 1024);
  try {
    const r = await fetch(url, {
      headers: { Range: `bytes=${inicio}-${total - 1}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const lidos = (await r.arrayBuffer()).byteLength;
    if (lidos === 0) throw new Error("cauda vazia");
  } catch (e) {
    throw new Error(
      `upload de ${(total / 1e6).toFixed(1)} MB ficou ilegível no fim (${(e as Error).message}) — ` +
      `o objeto subiu corrompido; refaça o passo. ${url}`,
    );
  }
}
