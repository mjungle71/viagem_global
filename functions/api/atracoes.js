/**
 * Rota — busca de atrações
 * Cloudflare Pages Function. Usa a mesma RAPIDAPI_KEY dos outros dois endpoints.
 *
 * O app chama POST /api/atracoes com:
 *   { cidade:"Goreme", termo:"balão", tipo:"passeios", ordenar:"lowest_price" }
 *
 * Dois passos: searchLocation resolve a cidade num id em base64,
 * searchAttractions devolve os produtos com preço POR PESSOA em BRL.
 *
 * O Booking marca os produtos com flags que resolvem o "com guia / sem guia":
 *   aiBadgesExpertGuide      → acompanhado de guia especializado
 *   aiBadgesAdmissionIncluded → a entrada já está inclusa
 *   aiBadgesPickup           → transporte incluído
 */

const HOST = "booking-com15.p.rapidapi.com";

/* etiquetas de tipo devolvidas pela própria API em filterOptions.typeFilters */
const TIPOS = {
  passeios:    "PTCMCuXtHgrC",
  museus:      "PTCMCcodv3rh",
  ingressos:   "PTCMCgNr9fWb",
  natureza:    "PTCMCLfBZQwO",
  gastronomia: "PTCMCi9PTIPL",
  workshops:   "PTCMClxjwGcP"
};

/* transfers e locações não são atração; entram como ruído na busca por cidade */
const RUIDO = /\b(transfer|traslado|transferência|transferencia|aluguel de carro|car rental|airport)\b/i;

const json = (dados, status) =>
  new Response(JSON.stringify(dados), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

const chamar = async (caminho, params, chave) => {
  const r = await fetch("https://" + HOST + caminho + "?" + params.toString(), {
    headers: { "x-rapidapi-host": HOST, "x-rapidapi-key": chave }
  });
  if (r.status === 403) throw Object.assign(new Error("A chave não tem assinatura ativa nessa API do RapidAPI."), { status: 403 });
  if (r.status === 429) throw Object.assign(new Error("Cota do RapidAPI esgotada por agora."), { status: 429 });
  if (!r.ok) throw Object.assign(new Error("O Booking respondeu " + r.status + "."), { status: 502 });
  return r.json();
};

const temFlag = (p, nome) =>
  Array.isArray(p.flags) && p.flags.some(f => f && f.flag === nome && f.value);

/* normaliza para comparar título com o termo buscado, sem acento nem caixa */
const chave = s => String(s || "").toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export async function onRequestPost({ request, env }) {
  const apiKey = env.RAPIDAPI_KEY;
  if (!apiKey) return json({ erro: "RAPIDAPI_KEY não está configurada no projeto do Cloudflare." }, 500);

  let c;
  try { c = await request.json(); }
  catch (e) { return json({ erro: "Requisição inválida." }, 400); }

  const cidade = String(c.cidade || "").trim();
  const termo = String(c.termo || "").trim();
  if (!cidade) return json({ erro: "Informe a cidade." }, 400);

  try {
    /* 1 — resolver a cidade */
    const d1 = await chamar("/api/v1/attraction/searchLocation",
      new URLSearchParams({ query: cidade, languagecode: "pt-br" }), apiKey);
    const destinos = (d1 && d1.data && d1.data.destinations) || [];
    if (!destinos.length)
      return json({ erro: 'Não encontrei nenhum lugar chamado "' + cidade + '" no Booking.' }, 404);
    const alvo = destinos[0];

    /* 2 — buscar produtos */
    const p = new URLSearchParams({
      id: alvo.id,
      sortBy: ["lowest_price", "highest_weighted_rating", "trending"].indexOf(c.ordenar) >= 0
        ? c.ordenar : "lowest_price",
      page: String(Math.max(1, Math.min(10, Number(c.pagina) || 1))),
      currency_code: "BRL",
      languagecode: "pt-br"
    });
    if (TIPOS[c.tipo]) p.set("typeFilters", TIPOS[c.tipo]);
    const d2 = await chamar("/api/v1/attraction/searchAttractions", p, apiKey);

    const dados = (d2 && d2.data) || {};
    const alvoChave = chave(termo);

    let itens = (dados.products || []).map(x => {
      const pr = x.representativePrice || {};
      const rs = (x.reviewsStats && x.reviewsStats.combinedNumericStats) || {};
      const preco = typeof pr.chargeAmount === "number" ? pr.chargeAmount : null;
      const cheio = typeof pr.publicAmount === "number" ? pr.publicAmount : null;
      return {
        id: x.id,
        nome: x.name || "",
        resumo: (x.shortDescription || "").replace(/\s+/g, " ").trim().slice(0, 160),
        preco,
        precoCheio: cheio && preco && cheio > preco ? cheio : null,
        desconto: cheio && preco && cheio > preco ? Math.round((1 - preco / cheio) * 100) : 0,
        nota: typeof rs.average === "number" ? rs.average : null,
        avaliacoes: rs.total || 0,
        foto: (x.primaryPhoto && x.primaryPhoto.small) || "",
        cidade: (x.ufiDetails && x.ufiDetails.bCityName) || "",
        comGuia: temFlag(x, "aiBadgesExpertGuide"),
        entradaInclusa: temFlag(x, "aiBadgesAdmissionIncluded"),
        transporte: temFlag(x, "aiBadgesPickup"),
        maisVendido: temFlag(x, "bestseller"),
        recomendado: temFlag(x, "recommendedByTravellers"),
        cancelaGratis: !!(x.cancellationPolicy && x.cancellationPolicy.hasFreeCancellation),
        url: x.slug ? "https://www.booking.com/attractions/" +
          ((x.ufiDetails && x.ufiDetails.url && x.ufiDetails.url.country) || "tr") +
          "/" + x.slug + ".pt-br.html" : ""
      };
    }).filter(x => x.preco != null && x.nome);

    /* fora transfers e afins, que não são atração */
    itens = itens.filter(x => !RUIDO.test(x.nome));

    /* se veio um termo, filtra pelo título e descrição */
    if (alvoChave) {
      const palavras = alvoChave.split(/\s+/).filter(w => w.length > 2);
      itens = itens.filter(x => {
        const alvo = chave(x.nome + " " + x.resumo);
        return palavras.every(w => alvo.indexOf(w) >= 0);
      });
    }

    itens.sort((a, b) => a.preco - b.preco);

    const comGuia = itens.filter(x => x.comGuia);
    const semGuia = itens.filter(x => !x.comGuia);
    const faixa = lista => lista.length
      ? { min: lista[0].preco, max: lista[lista.length - 1].preco, n: lista.length }
      : null;

    return json({
      cidade: alvo.cityName || cidade,
      pais: alvo.country || "",
      termo,
      tipo: c.tipo || "",
      totalNoDestino: alvo.productCount || 0,
      total: itens.length,
      faixaGeral: faixa(itens),
      faixaComGuia: faixa(comGuia),
      faixaSemGuia: faixa(semGuia),
      tipos: (dados.filterOptions && dados.filterOptions.typeFilters || [])
        .map(f => ({ nome: f.name, etiqueta: f.tagname, n: f.productCount })),
      itens: itens.slice(0, 40)
    });
  } catch (e) {
    return json({ erro: String(e.message || e) }, e.status || 502);
  }
}

export const onRequestGet = () => json({ erro: "Use POST." }, 405);
