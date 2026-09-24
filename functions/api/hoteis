/**
 * Rota — busca de hotéis
 * Cloudflare Pages Function. Usa a mesma RAPIDAPI_KEY já configurada nos secrets.
 *
 * O app chama POST /api/hoteis com:
 *   { cidade:"Istambul", entrada:"2027-05-06", saida:"2027-05-10",
 *     quartos:2, adultos:4, cafe:true }
 *
 * Faz dois passos: searchDestination resolve a cidade num dest_id,
 * searchHotels busca com as datas. O grossPrice devolvido pelo Booking é o
 * TOTAL da estadia somando todos os quartos — a diária por quarto sai
 * dividindo por noites e por quartos.
 */

const HOST = "booking-com15.p.rapidapi.com";

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

const noites = (a, b) => Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));

/* O rótulo de acessibilidade é a única fonte de algumas informações: refeição
   incluída, bairro, distância do centro e cancelamento grátis não existem em
   campos próprios na resposta. */
function lerRotulo(txt) {
  const t = String(txt || "");
  const linhas = t.split("\n").map(s => s.trim()).filter(Boolean);
  const acha = re => { const m = t.match(re); return m ? m[0].trim() : ""; };
  const temCafe = /caf[ée] da manh[ãa][^.]*inclu/i.test(t) || /breakfast included/i.test(t);
  return {
    cafe: temCafe,
    jantar: /jantar inclu/i.test(t),
    bairro: (linhas.find(l => /•/.test(l)) || "").split("•")[0].replace(/[‎‬]/g, "").trim(),
    doCentro: acha(/[\d.,]+\s*km do centro/i).replace(/[‎‬]/g, ""),
    daPraia: acha(/[\d.,]+\s*(km|m) da praia/i).replace(/[‎‬]/g, ""),
    cancelaGratis: /cancelamento gr[áa]tis/i.test(t),
    semPrePagamento: /n[ãa]o requer pr[ée]-pagamento/i.test(t),
    quartos: acha(/\d+\s+quartos?[^:]*:/i).replace(/:$/, "").trim()
  };
}

export async function onRequestPost({ request, env }) {
  const chave = env.RAPIDAPI_KEY;
  if (!chave) return json({ erro: "RAPIDAPI_KEY não está configurada no projeto do Cloudflare." }, 500);

  let c;
  try { c = await request.json(); }
  catch (e) { return json({ erro: "Requisição inválida." }, 400); }

  const cidade = String(c.cidade || "").trim();
  const entrada = String(c.entrada || "").trim();
  const saida = String(c.saida || "").trim();
  if (!cidade) return json({ erro: "Informe a cidade ou o nome do local." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entrada) || !/^\d{4}-\d{2}-\d{2}$/.test(saida))
    return json({ erro: "Informe check-in e check-out no formato AAAA-MM-DD." }, 400);
  if (Date.parse(saida) <= Date.parse(entrada))
    return json({ erro: "O check-out precisa ser depois do check-in." }, 400);

  const quartos = Math.max(1, Math.min(30, Number(c.quartos) || 1));
  const adultos = Math.max(1, Math.min(30, Number(c.adultos) || 1));
  const n = noites(entrada, saida);

  try {
    /* 1 — resolver a cidade num dest_id */
    const d1 = await chamar("/api/v1/hotels/searchDestination",
      new URLSearchParams({ query: cidade }), chave);
    const destinos = (d1 && d1.data) || [];
    if (!destinos.length)
      return json({ erro: 'Não encontrei nenhum lugar chamado "' + cidade + '" no Booking.' }, 404);

    /* prefere cidade a região ou ponto isolado */
    const alvo = destinos.find(x => x.search_type === "city") || destinos[0];

    /* 2 — buscar hotéis */
    const p = new URLSearchParams({
      dest_id: String(alvo.dest_id),
      search_type: String(alvo.search_type || "CITY").toUpperCase(),
      arrival_date: entrada,
      departure_date: saida,
      adults: String(adultos),
      room_qty: String(quartos),
      page_number: "1",
      units: "metric",
      temperature_unit: "c",
      languagecode: "pt-br",
      currency_code: "BRL",
      location: "BR"
    });
    if (c.ordenar) p.set("sort_by", String(c.ordenar));
    const d2 = await chamar("/api/v1/hotels/searchHotels", p, chave);

    const brutos = (d2 && d2.data && d2.data.hotels) || [];
    let hoteis = brutos.map(h => {
      const pr = (h.property && h.property.priceBreakdown) || {};
      const total = pr.grossPrice && typeof pr.grossPrice.value === "number" ? pr.grossPrice.value : null;
      const taxas = pr.excludedPrice && typeof pr.excludedPrice.value === "number" ? pr.excludedPrice.value : 0;
      const de = pr.strikethroughPrice && typeof pr.strikethroughPrice.value === "number"
        ? pr.strikethroughPrice.value : null;
      const info = lerRotulo(h.accessibilityLabel);
      const prop = h.property || {};
      return {
        id: h.hotel_id,
        nome: prop.name || "",
        nota: typeof prop.reviewScore === "number" && prop.reviewScore > 0 ? prop.reviewScore : null,
        notaTexto: prop.reviewScoreWord || "",
        avaliacoes: prop.reviewCount || 0,
        estrelas: prop.accuratePropertyClass || prop.propertyClass || 0,
        foto: (prop.photoUrls && prop.photoUrls[0]) || "",
        lat: prop.latitude, lon: prop.longitude,
        /* a diária que interessa: total da estadia ÷ noites ÷ quartos */
        diaria: total == null ? null : total / n / quartos,
        diariaComTaxas: total == null ? null : (total + taxas) / n / quartos,
        total, taxas,
        desconto: de && total && de > total ? Math.round((1 - total / de) * 100) : 0,
        cafe: info.cafe, jantar: info.jantar,
        bairro: info.bairro, doCentro: info.doCentro, daPraia: info.daPraia,
        cancelaGratis: info.cancelaGratis, semPrePagamento: info.semPrePagamento,
        arranjo: info.quartos
      };
    }).filter(h => h.diaria != null && h.nome);

    if (c.cafe) hoteis = hoteis.filter(h => h.cafe);
    hoteis.sort((a, b) => a.diaria - b.diaria);

    return json({
      cidade: alvo.label || alvo.name || cidade,
      destId: alvo.dest_id,
      entrada, saida, noites: n, quartos, adultos,
      soCafe: !!c.cafe,
      total: hoteis.length,
      hoteis: hoteis.slice(0, 40)
    });
  } catch (e) {
    return json({ erro: String(e.message || e) }, e.status || 502);
  }
}

export const onRequestGet = () => json({ erro: "Use POST." }, 405);
