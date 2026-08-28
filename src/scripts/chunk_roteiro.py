#!/usr/bin/env python3
"""Fatia um roteiro em clipes de ~55-60 silabas (o ritmo natural de fala
que o Kling sustenta em ~10s), sem nunca cortar no meio de uma frase.

  python3 chunk_roteiro.py roteiro.txt --lang pt
  python3 chunk_roteiro.py roteiro.txt --lang en --json
  python3 chunk_roteiro.py roteiro.txt --lang en --ref-dur 32.5
  echo "texto..." | python3 chunk_roteiro.py - --lang pt

A contagem de silabas e heuristica (grupos de vogais), nao um silabador
completo. Isso basta para fatiar: o erro tipico e de 1-2 silabas por frase,
bem dentro da folga da janela 55-60.

SEMPRE passe --ref-dur com a duracao real do criativo de referencia. O ritmo
de locucao de anuncio varia muito (3.5 a 6 silabas/s conforme as pausas), e
o default generico erra facil 40%. Com --ref-dur o script calibra o ritmo no
proprio original -- que e o ritmo que voce esta tentando reproduzir.
"""
import argparse
import json
import re
import sys

VOGAIS = "aeiouáàâãéêíóôõúüy"

# Ditongos e digrafos que formam UMA silaba, nao duas.
DITONGOS_PT = ("ai", "ei", "oi", "ui", "au", "eu", "iu", "ou", "ão", "ãe",
               "õe", "ãi", "ua", "ue", "uo", "ia", "ie", "io")
DITONGOS_EN = ("ai", "au", "ay", "ea", "ee", "ei", "ey", "ie", "oa", "oi",
               "oo", "ou", "ow", "oy", "ue", "ui")

SILABAS_ALVO = 58        # centro da janela 55-60
SILABAS_MAX = 66         # teto antes de forcar quebra
SILABAS_POR_SEGUNDO = 4.3  # locucao de anuncio, com pausas. Calibre com --ref-dur.
DUR_MIN, DUR_MAX = 3, 15   # limites do Kling


def contar_silabas(texto: str, lang: str) -> int:
    """Conta grupos de vogais, descontando ditongos e 'e' mudo final (en)."""
    ditongos = DITONGOS_PT if lang == "pt" else DITONGOS_EN
    total = 0
    for palavra in re.findall(r"[a-zà-ÿ]+", texto.lower()):
        grupos = re.findall(r"[%s]+" % VOGAIS, palavra)
        n = len(grupos)
        for g in grupos:
            for i in range(len(g) - 1):
                if g[i:i + 2] in ditongos:
                    n -= 1
        if lang == "en" and palavra.endswith("e") and n > 1:
            n -= 1  # silent e
        total += max(n, 1)
    return total


def dividir_frases(texto: str) -> list[str]:
    """Quebra em frases. Fronteira de frase e a unica emenda aceitavel."""
    texto = " ".join(texto.split())
    partes = re.split(r"(?<=[.!?…])\s+", texto)
    return [p.strip() for p in partes if p.strip()]


def duracao_kling(silabas: int, ritmo: float) -> int:
    seg = round(silabas / ritmo)
    return max(DUR_MIN, min(DUR_MAX, seg))


def fatiar(texto: str, lang: str, ritmo: float) -> list[dict]:
    """Distribui as frases em N clipes equilibrados.

    Fatiar de forma gulosa deixa um clipe-anao no fim (ex: 46/61/21), e um
    clipe de 4s ao lado de um de 11s da um corte que salta na montagem.
    Entao fixamos N pelo total e miramos total/N em cada clipe: as emendas
    continuam so em fronteira de frase, mas os pedacos saem parelhos.
    """
    frases = [(f, contar_silabas(f, lang)) for f in dividir_frases(texto)]
    if not frases:
        return []

    total = sum(s for _, s in frases)
    teto = int(DUR_MAX * ritmo)   # um clipe nao pode passar de 15s de fala
    piso = int(DUR_MIN * ritmo)   # nem ficar abaixo de 3s

    n_clipes = max(1, round(total / SILABAS_ALVO))
    while n_clipes < len(frases) and total / n_clipes > teto:
        n_clipes += 1
    n_clipes = min(n_clipes, len(frases))
    alvo = total / n_clipes

    # Particao otima por programacao dinamica: divide as frases em n_clipes
    # grupos CONTIGUOS (a emenda so cai em fronteira de frase) minimizando o
    # desvio quadratico em relacao ao alvo. Guloso deixava clipe-anao ao lado
    # de clipe-teto (46/23/59), e corte de 6s colado num de 15s salta na
    # montagem. Com poucas frases o custo do DP e irrisorio.
    n = len(frases)
    pref = [0] * (n + 1)
    for i, (_, s) in enumerate(frases):
        pref[i + 1] = pref[i] + s

    def custo(i: int, j: int) -> float:
        """Custo do grupo frases[i:j]."""
        soma = pref[j] - pref[i]
        pen = 0.0
        if soma > teto:                      # estoura o Kling: proibido na pratica
            pen += 1e6 * (soma - teto)
        if soma < piso and j - i < n:        # curto demais para virar clipe
            pen += 1e3 * (piso - soma)
        return (soma - alvo) ** 2 + pen

    INF = float("inf")
    # dp[k][j] = melhor custo usando k grupos para as j primeiras frases
    dp = [[INF] * (n + 1) for _ in range(n_clipes + 1)]
    corte = [[0] * (n + 1) for _ in range(n_clipes + 1)]
    dp[0][0] = 0.0
    for k in range(1, n_clipes + 1):
        for j in range(k, n - (n_clipes - k) + 1):
            for i in range(k - 1, j):
                if dp[k - 1][i] == INF:
                    continue
                c = dp[k - 1][i] + custo(i, j)
                if c < dp[k][j]:
                    dp[k][j] = c
                    corte[k][j] = i

    limites, j = [], n
    for k in range(n_clipes, 0, -1):
        i = corte[k][j]
        limites.append((i, j))
        j = i
    limites.reverse()

    clipes = [
        (" ".join(f for f, _ in frases[i:j]), pref[j] - pref[i])
        for i, j in limites
    ]

    return [
        {
            "n": i,
            "texto": t,
            "silabas": s,
            "duracao_kling": duracao_kling(s, ritmo),
        }
        for i, (t, s) in enumerate(clipes, 1)
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("arquivo", help="arquivo do roteiro, ou - para stdin")
    ap.add_argument("--lang", choices=["pt", "en"], default="pt")
    ap.add_argument("--ref-dur", type=float, metavar="SEG",
                    help="duracao real do criativo de referencia, em segundos. "
                         "Calibra o ritmo no proprio original -- use sempre que tiver.")
    ap.add_argument("--ritmo", type=float, metavar="SIL/S",
                    help=f"silabas por segundo, se voce ja sabe (default {SILABAS_POR_SEGUNDO})")
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args()

    texto = sys.stdin.read() if args.arquivo == "-" else open(args.arquivo, encoding="utf-8").read()
    if not texto.strip():
        print("roteiro vazio", file=sys.stderr)
        return 1

    total_silabas = contar_silabas(texto, args.lang)

    if args.ritmo:
        ritmo, origem = args.ritmo, "informado"
    elif args.ref_dur and args.ref_dur > 0:
        ritmo = total_silabas / args.ref_dur
        origem = f"calibrado no original ({total_silabas} sil / {args.ref_dur:g}s)"
    else:
        ritmo, origem = SILABAS_POR_SEGUNDO, "DEFAULT GENERICO — passe --ref-dur"

    clipes = fatiar(texto, args.lang, ritmo)

    if args.as_json:
        print(json.dumps({"ritmo": round(ritmo, 2), "clipes": clipes},
                         ensure_ascii=False, indent=2))
        return 0

    total_d = sum(c["duracao_kling"] for c in clipes)
    print(f"{len(clipes)} clipes · {total_silabas} silabas · ~{total_d}s")
    print(f"ritmo: {ritmo:.2f} sil/s ({origem})\n")
    for c in clipes:
        print(f"[{c['n']}] {c['silabas']} sil · {c['duracao_kling']}s")
        print(f"    {c['texto']}\n")

    if args.ref_dur:
        delta = total_d - args.ref_dur
        if abs(delta) > 2:
            print(f"AVISO: soma dos clipes ({total_d}s) foge {delta:+.0f}s do original "
                  f"({args.ref_dur:g}s) — o arredondamento por clipe acumulou.\n"
                  f"Ajuste a duracao de um clipe na mao para fechar.")
        else:
            print(f"Soma bate com o original ({args.ref_dur:g}s), folga de {delta:+.0f}s.")
    else:
        print("Sem --ref-dur o ritmo e um chute. Rode /watch no criativo de\n"
              "referencia, pegue a duracao real e passe aqui.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
