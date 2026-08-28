#!/usr/bin/env python3
"""Le a ESTRUTURA DE EDICAO de um criativo de video: em que faixas horizontais
a tela esta dividida, e em que instantes o layout muda.

  python3 analisar_estrutura.py criativo.mp4
  python3 analisar_estrutura.py criativo.mp4 --json > estrutura.json
  python3 analisar_estrutura.py criativo.mp4 --precisao 0.04   # busca fina do corte

Por que isso existe: medir a olho onde termina o talking head e comeca o painel
de baixo produz erro de dezenas de pixels, e a emenda aparece. O video carrega
essa informacao -- faixas diferentes tem estatistica de linha diferente.

Como funciona:
  1. Amostra frames ao longo do video.
  2. Para cada frame monta uma assinatura: media e desvio-padrao por linha.
  3. Instantes em que a assinatura muda de repente = trocas de layout (cortes).
  4. Dentro de cada segmento, linhas onde a estatistica salta = fronteiras de faixa.

Requer numpy e ffmpeg/ffprobe no PATH.
"""
import argparse
import json
import subprocess
import sys

try:
    import numpy as np
except ImportError:
    sys.exit("precisa de numpy: python3 -m pip install numpy")


def probe(caminho: str) -> dict:
    campos = "stream=width,height,r_frame_rate:format=duration"
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", campos, "-of", "json", caminho],
        capture_output=True, text=True).stdout
    d = json.loads(out)
    s = d["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return {
        "largura": int(s["width"]),
        "altura": int(s["height"]),
        "fps": float(num) / float(den),
        "duracao": float(d["format"]["duration"]),
    }


def frame(caminho: str, t: float, w: int, h: int):
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", caminho,
         "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True)
    if len(p.stdout) < w * h * 3:
        return None
    return np.frombuffer(p.stdout[:w * h * 3], dtype=np.uint8).reshape(h, w, 3).astype(np.float32)


def assinatura(img):
    """Vetor por linha: media dos canais + desvio-padrao horizontal + 'vermelhidao'.

    Media sozinha nao distingue uma faixa de UI clara de um rosto claro. O
    desvio horizontal separa area lisa (barra solida) de area com conteudo, e
    a vermelhidao acha barras de caption, que sao quase sempre coloridas.
    """
    media = img.mean(axis=(1, 2))
    desvio = img.mean(axis=2).std(axis=1)
    vermelho = img[:, :, 0].mean(axis=1) - (img[:, :, 1].mean(axis=1) + img[:, :, 2].mean(axis=1)) / 2
    return np.stack([media, desvio, vermelho])


def achar_cortes(caminho, info, passo, limiar):
    """Instantes em que a assinatura de linha muda bruscamente."""
    w, h, dur = info["largura"], info["altura"], info["duracao"]
    ts, sigs = [], []
    t = 0.0
    while t < dur - 0.05:
        img = frame(caminho, t, w, h)
        if img is not None:
            ts.append(round(t, 3))
            sigs.append(assinatura(img))
        t += passo

    cortes, dists = [], []
    for i in range(1, len(sigs)):
        d = float(np.abs(sigs[i] - sigs[i - 1]).mean())
        dists.append(d)
    if not dists:
        return [], []
    base = float(np.median(dists))
    for i, d in enumerate(dists):
        if d > max(limiar, base * 4):
            cortes.append((ts[i], ts[i + 1], d))
    return cortes, list(zip(ts, dists))


def refinar_corte(caminho, info, t0, t1, precisao):
    """Busca binaria entre dois instantes ate a precisao pedida."""
    w, h = info["largura"], info["altura"]
    a = frame(caminho, t0, w, h)
    if a is None:
        return t1
    sa = assinatura(a)
    lo, hi = t0, t1
    while hi - lo > precisao:
        meio = (lo + hi) / 2
        m = frame(caminho, meio, w, h)
        if m is None:
            break
        # perto de sa => ainda no layout antigo
        if float(np.abs(assinatura(m) - sa).mean()) < 8:
            lo = meio
        else:
            hi = meio
    return round(hi, 3)


def achar_faixas(caminho, info, ini, fim, min_altura, n_amostras=5):
    """Fronteiras horizontais ESTAVEIS dentro de um trecho.

    Uma fronteira de layout fica parada durante todo o segmento; uma borda de
    conteudo (post rolando, corte dentro do painel) se move. Entao exigimos que
    o pico de gradiente apareca em TODAS as amostras: tomamos o minimo do perfil
    entre frames antes de procurar pico. Sem isso o feed do Instagram rolando
    vira "faixa" e a analise devolve lixo.
    """
    w, h = info["largura"], info["altura"]
    perfis, imgs = [], []
    for i in range(n_amostras):
        t = ini + (fim - ini) * (i + 0.5) / n_amostras
        img = frame(caminho, t, w, h)
        if img is None:
            continue
        imgs.append(img)
        grad = np.abs(np.diff(assinatura(img), axis=1)).mean(axis=0)
        k = max(3, h // 200)
        perfis.append(np.convolve(grad, np.ones(k) / k, mode="same"))
    if not perfis:
        return []

    estavel = np.min(np.stack(perfis), axis=0)   # so sobrevive o que esta em todos
    lim = float(np.median(estavel) + 4 * estavel.std())

    # Alem de estavel e alto, a fronteira precisa ser NITIDA. Uma divisao de
    # layout troca de fonte em 1-2 linhas; uma borda de cena (a linha do teto de
    # um comodo, o encosto de um sofa) sobe devagar. Exigir proeminencia local
    # descarta a segunda sem descartar a primeira.
    jan = max(6, h // 80)
    picos = []
    y = 1
    while y < h - 1:
        viz = estavel[max(0, y - jan):y + jan + 1]
        nitido = estavel[y] > 2.5 * float(np.median(viz))
        if estavel[y] > lim and nitido and estavel[y] >= estavel[max(0, y - 2):y + 3].max():
            if not picos or y - picos[-1] >= min_altura:
                picos.append(y)
            y += min_altura // 2
        else:
            y += 1

    ref = imgs[len(imgs) // 2]
    limites = [0] + picos + [h]
    faixas = []
    for i in range(len(limites) - 1):
        y0, y1 = limites[i], limites[i + 1]
        if y1 - y0 < min_altura:
            continue
        faixas.append(descrever(ref, y0, y1, h))

    # Fundir vizinhas de mesmo carater. Nem toda borda horizontal estavel e uma
    # divisao de layout: a linha do teto de um comodo fica parada o video
    # inteiro e vira "faixa". Divisao real junta fontes VISUALMENTE distintas
    # (rosto x captura de tela x barra colorida), entao exigimos que as duas
    # metades tenham estatistica diferente para manter a fronteira.
    fundidas = [faixas[0]] if faixas else []
    for f in faixas[1:]:
        a = fundidas[-1]
        if (abs(a["media"] - f["media"]) < 18
                and abs(a["vermelhidao"] - f["vermelhidao"]) < 20
                and abs(a["desvio_horizontal"] - f["desvio_horizontal"]) < 12):
            fundidas[-1] = descrever(ref, a["y0"], f["y1"], h)
        else:
            fundidas.append(f)
    return fundidas


def descrever(img, y0, y1, h):
    bloco = img[y0:y1]
    return {
        "y0": int(y0), "y1": int(y1), "altura": int(y1 - y0),
        "fracao": round((y1 - y0) / h, 4),
        "media": round(float(bloco.mean()), 1),
        "desvio_horizontal": round(float(bloco.mean(axis=2).std(axis=1).mean()), 1),
        "vermelhidao": round(float(bloco[:, :, 0].mean() - (bloco[:, :, 1].mean() + bloco[:, :, 2].mean()) / 2), 1),
    }


def mesma_estrutura(a, b, tol, min_frac=0.15):
    """Mesmo layout = as fronteiras PRINCIPAIS coincidem.

    Comparar a lista inteira de faixas e fragil: uma barra de caption as vezes
    sai como um bloco e as vezes como dois, e a comparacao falha por isso, nao
    porque o layout mudou. Comparar so as faixas grandes (>=15%) deixa a comparacao estavel: barra de
    caption e lettering quase nunca passam disso, painel de conteudo sempre passa.
    """
    def principais(fs):
        return [f["y0"] for f in fs if f["fracao"] >= min_frac and f["y0"] > 0]
    pa, pb = principais(a), principais(b)
    if len(pa) != len(pb):
        return False
    return all(abs(x - y) <= tol for x, y in zip(pa, pb))


def rotular(f, h):
    """Palpite do papel de cada faixa. E palpite -- confirme olhando um frame."""
    if f["vermelhidao"] > 25 and f["fracao"] < 0.25:
        return "barra de caption / lettering"
    if f["desvio_horizontal"] < 12:
        return "faixa lisa (borda ou fundo chapado)"
    if f["fracao"] > 0.55:
        return "painel principal"
    return "painel"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--passo", type=float, default=0.5, help="amostragem inicial em s (default 0.5)")
    ap.add_argument("--precisao", type=float, default=0.05, help="precisao do corte em s (default 0.05)")
    ap.add_argument("--limiar", type=float, default=6.0)
    ap.add_argument("--min-altura", type=int, default=0, help="altura minima de faixa em px (default: 4%% da altura)")
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args()

    info = probe(args.video)
    min_altura = args.min_altura or max(8, int(info["altura"] * 0.04))

    brutos, _ = achar_cortes(args.video, info, args.passo, args.limiar)
    cortes = [refinar_corte(args.video, info, t0, t1, args.precisao) for t0, t1, _ in brutos]

    marcos = [0.0] + cortes + [info["duracao"]]
    brutos_seg = []
    for i in range(len(marcos) - 1):
        ini, fim = marcos[i], marcos[i + 1]
        if fim - ini < 0.3:
            continue
        brutos_seg.append({
            "inicio": round(ini, 3), "fim": round(fim, 3),
            "faixas": achar_faixas(args.video, info, ini, fim, min_altura),
        })

    # Fundir vizinhos com o mesmo layout. O detector de corte dispara tambem em
    # troca de CONTEUDO (o feed rolando, um b-roll trocando). So e corte de
    # edicao de verdade quando a estrutura de faixas muda dos dois lados.
    tol = max(4, int(info["altura"] * 0.02))
    segmentos = []
    for s in brutos_seg:
        if segmentos and mesma_estrutura(segmentos[-1]["faixas"], s["faixas"], tol):
            segmentos[-1]["fim"] = s["fim"]
        else:
            segmentos.append(s)

    for s in segmentos:
        s["duracao"] = round(s["fim"] - s["inicio"], 3)
        s["layout"] = "dividido" if len(s["faixas"]) > 1 else "tela cheia"
        for f in s["faixas"]:
            f["papel"] = rotular(f, info["altura"])

    cortes_reais = [s["inicio"] for s in segmentos[1:]]
    descartados = [c for c in cortes if c not in cortes_reais]
    saida = {"video": args.video, **info, "cortes": cortes_reais,
             "cortes_de_conteudo_descartados": descartados, "segmentos": segmentos}

    if args.as_json:
        print(json.dumps(saida, ensure_ascii=False, indent=2))
        return 0

    print(f"{args.video}")
    print(f"  {info['largura']}x{info['altura']} · {info['fps']:.3g}fps · {info['duracao']:.2f}s")
    print(f"  cortes de LAYOUT: {', '.join(f'{c:.2f}s' for c in cortes_reais) or 'nenhum'}")
    if descartados:
        print(f"  (descartados como troca de conteudo, nao de layout: "
              f"{', '.join(f'{c:.2f}s' for c in descartados)})")
    print()
    for i, s in enumerate(segmentos, 1):
        print(f"SEGMENTO {i}: {s['inicio']:.2f}s -> {s['fim']:.2f}s ({s['duracao']:.2f}s) · {s['layout']}")
        for f in s["faixas"]:
            print(f"    y {f['y0']:>5}-{f['y1']:<5} h={f['altura']:<5} ({f['fracao']*100:4.1f}%)  {f['papel']}")
        print()
    print("Os papeis das faixas sao palpite estatistico. Extraia um frame de cada")
    print("segmento e confirme com o olho antes de cortar em cima disso.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
