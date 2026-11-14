/**
 * Rota — busca de voos
 * Cloudflare Pages Function. Roda no servidor, então a chave do RapidAPI fica
 * num secret do projeto e nunca aparece no código da página.
 *
 * Configurar em: Cloudflare > Pages > o projeto > Settings > Variables and Secrets
 *   RAPIDAPI_KEY = a chave do RapidAPI (marcar como Secret, não como plaintext)
 *
 * O app chama POST /api/voos com:
 *   { de:"GRU", para:"IST", data:"2027-05-06", adultos:4, criancas:0, classe:"ECONOMY",
 *     filtro:{ empresa:"Turkish", numero:"AD 8750 TK 1756", paradas:"direto",
 *              sai:"noite", chega:"tarde" } }
 *
 * O filtro é aplicado aqui, antes de cortar nos 40 melhores: um voo específico
 * pode estar em quinquagésimo lugar por preço e precisa ser encontrado mesmo assim.
 */

const HOST = "google-flights2.p.rapidapi.com";

const json = (dados, status) =>
  new Response(JSON.stringify(dados), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

/* O "stops" da API vem 0 em todo itinerário, inclusive nos que têm duas conexões.
   O número real de escalas é o tamanho de layovers — é isso que usamos. */
function normalizarVoo(v, melhor) {
  const pernas = Array.isArray(v.flights) ? v.flights : [];
  const paradas = Array.isArray(v.layovers) ? v.layovers : [];
  const primeira = pernas[0] || {};
  const ultima = pernas[pernas.length - 1] || {};
  const cias = [];
  pernas.forEach(f => { if (f.airline && cias.indexOf(f.airline) < 0) cias.push(f.airline); });

  return {
    preco: v.price,
    duracao: (v.duration && v.duration.raw) || 0,
    escalas: paradas.length,
    espera: paradas.reduce((a, l) => a + (Number(l.duration) || 0), 0),
    conexoes: paradas.map(l => ({
      codigo: l.airport_code || "",
      cidade: l.city || l.airport_name || "",
      minutos: Number(l.duration) || 0
    })),
    cias,
    numeros: pernas.map(f => [f.airline_code, f.flight_number].filter(Boolean).join(" ") || f.flight_number || ""),
    saida: (primeira.departure_airport && primeira.departure_airport.time) || "",
    chegada: (ultima.arrival_airport && ultima.arrival_airport.time) || "",
    origem: (primeira.departure_airport && primeira.departure_airport.airport_code) || "",
    destino: (ultima.arrival_airport && ultima.arrival_airport.airport_code) || "",
    logo: v.airline_logo || "",
    co2: (v.carbon_emissions && v.carbon_emissions.difference_percent),
    melhor: !!melhor,
    token: v.booking_token || ""
  };
}

/* ---------------------------------------------------------------- filtro ---
   Tudo o que dá para filtrar já vem em normalizarVoo, então nada disso custa
   uma chamada a mais à API: filtramos a lista que ela devolveu. */
const FAIXAS = { madrugada:[0,4], manha:[5,11], tarde:[12,17], noite:[18,23] };

/* O horário vem como "2027-05-06 22:30" em uns itinerários e ISO em outros,
   então pegamos a primeira hora que aparecer no texto. */
export function horaDe(txt) {
  const m = String(txt || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}
function casaFaixa(txt, faixa) {
  if (!faixa || !FAIXAS[faixa]) return true;
  const h = horaDe(txt);
  if (h == null) return false;   /* sem horário, não dá para afirmar que casa */
  const [a, b] = FAIXAS[faixa];
  return h >= a && h <= b;
}
/* sem acento, sem espaço, tudo maiúsculo: "Latam" acha "LATAM", "tk 16" acha "TK16" */
const limpo = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toUpperCase().replace(/\s+/g, "");
const sigla   = s => (s.match(/^[A-Z]+/) || [""])[0];
const digitos = s => s.replace(/^[A-Z]+/, "");

export function casaVoo(v, f) {
  if (!f) return true;
  if (f.paradas === "direto" && v.escalas > 0) return false;
  if (f.paradas === "escala" && v.escalas === 0) return false;
  if (!casaFaixa(v.saida, f.sai)) return false;
  if (!casaFaixa(v.chegada, f.chega)) return false;

  if (f.empresa) {
    const alvo = limpo(f.empresa);
    const achou = (v.cias || []).some(c => limpo(c).indexOf(alvo) >= 0)
               || (v.numeros || []).some(x => limpo(x).indexOf(alvo) >= 0);
    if (!achou) return false;
  }
  if (f.numero) {
    /* Pode vir mais de um número, para quem já sabe a conexão que quer:
       "AD 8750 TK 1756" tem de achar o itinerário que traz AS DUAS pernas.
       Por isso não dá para quebrar no espaço — "AD 8750" viraria "AD" e
       "8750" —, e sim reconhecer cada número com sigla opcional. */
    const pedidos = numerosPedidos(f.numero);
    if (!pedidos.length) return false;
    const temAPerna = alvo => {
      const d = digitos(alvo), c = sigla(alvo);
      if (!d) return false;
      /* o número casa inteiro, nunca por pedaço, senão 16 acharia o voo 160 */
      return (v.numeros || []).some(x => {
        const p = limpo(x);
        return digitos(p) === d && (!c || sigla(p) === c);
      });
    };
    if (!pedidos.every(temAPerna)) return false;
  }
  return true;
}
/* "TK 16" · "tk16" · "AD 8750 TK 1756" · "AD8750, TK1756" → ["AD8750","TK1756"] */
export function numerosPedidos(txt) {
  const achados = String(txt || "").toUpperCase().match(/[A-Z]{0,3}\s?\d{1,5}/g) || [];
  return achados.map(limpo).filter(Boolean);
}
/* Devolve só o que o usuário realmente pediu, para o app saber o que aplicou. */
export function lerFiltro(f) {
  if (!f || typeof f !== "object") return null;
  const txt = x => String(x || "").trim().slice(0, 40);
  const faixa = x => FAIXAS[x] ? x : "";
  const out = {
    empresa: txt(f.empresa), numero: String(f.numero || "").trim().slice(0, 60),
    paradas: (f.paradas === "direto" || f.paradas === "escala") ? f.paradas : "",
    sai: faixa(f.sai), chega: faixa(f.chega)
  };
  return Object.keys(out).some(k => out[k]) ? out : null;
}

/* priceHistory traz faixas em formato de operadores. O campo "high" vem com o
   operador "<" onde deveria ser ">", então derivamos os limites pelos valores
   de "low" e "typical", que são consistentes. */
function faixaDePreco(ph) {
  if (!ph || !ph.summary) return null;
  const s = ph.summary;
  const atual = typeof s.current === "number" ? s.current : null;
  if (atual == null) return null;
  const num = lista => (Array.isArray(lista) ? lista : [])
    .map(x => x && typeof x.value === "number" ? x.value : null)
    .filter(x => x != null);
  const baixo = num(s.low);
  const tipico = num(s.typical);
  const limiteBaixo = baixo.length ? Math.min.apply(null, baixo) : null;
  const limiteAlto = tipico.length ? Math.max.apply(null, tipico) : null;
  let nivel = "desconhecido";
  if (limiteBaixo != null && atual < limiteBaixo) nivel = "baixo";
  else if (limiteAlto != null && atual <= limiteAlto) nivel = "tipico";
  else if (limiteAlto != null) nivel = "alto";
  return { atual, limiteBaixo, limiteAlto, nivel };
}

export async function onRequestPost({ request, env }) {
  const chave = env.RAPIDAPI_KEY;
  if (!chave) return json({ erro: "RAPIDAPI_KEY não está configurada no projeto do Cloudflare." }, 500);

  let corpo;
  try { corpo = await request.json(); }
  catch (e) { return json({ erro: "Requisição inválida." }, 400); }

  const de = String(corpo.de || "").trim().toUpperCase();
  const para = String(corpo.para || "").trim().toUpperCase();
  const data = String(corpo.data || "").trim();
  if (!/^[A-Z]{3}$/.test(de) || !/^[A-Z]{3}$/.test(para))
    return json({ erro: "Informe os códigos IATA de origem e destino, com três letras." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data))
    return json({ erro: "Informe a data no formato AAAA-MM-DD." }, 400);

  const p = new URLSearchParams({
    departure_id: de,
    arrival_id: para,
    outbound_date: data,
    adults: String(Math.max(1, Number(corpo.adultos) || 1)),
    travel_class: ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"].indexOf(corpo.classe) >= 0
      ? corpo.classe : "ECONOMY",
    show_hidden: "1",
    currency: "BRL",
    language_code: "pt-BR",
    country_code: "BR",
    search_type: "best"
  });
  if (Number(corpo.criancas) > 0) p.set("children", String(Number(corpo.criancas)));

  let resposta;
  try {
    resposta = await fetch("https://" + HOST + "/api/v1/searchFlights?" + p.toString(), {
      headers: { "x-rapidapi-host": HOST, "x-rapidapi-key": chave }
    });
  } catch (e) {
    return json({ erro: "Não consegui falar com o serviço de voos." }, 502);
  }

  if (resposta.status === 403)
    return json({ erro: "A chave não tem assinatura ativa nessa API do RapidAPI." }, 403);
  if (resposta.status === 429)
    return json({ erro: "Cota do RapidAPI esgotada por agora." }, 429);
  if (!resposta.ok)
    return json({ erro: "O serviço de voos respondeu " + resposta.status + "." }, 502);

  let d;
  try { d = await resposta.json(); }
  catch (e) { return json({ erro: "Resposta ilegível do serviço de voos." }, 502); }

  const it = (d && d.data && d.data.itineraries) || {};
  const brutos = []
    .concat((it.topFlights || []).map(v => [v, true]))
    .concat((it.otherFlights || []).map(v => [v, false]));

  const vistos = {};
  const voos = [];
  for (const [v, melhor] of brutos) {
    /* preço nem sempre é número: vem "unavailable" em alguns itinerários */
    if (typeof v.price !== "number" || !(v.price > 0)) continue;
    const n = normalizarVoo(v, melhor);
    const chaveVoo = n.numeros.join(">") + "|" + n.preco;
    if (vistos[chaveVoo]) continue;
    vistos[chaveVoo] = true;
    voos.push(n);
  }

  /* melhor custo-benefício primeiro, depois por preço */
  voos.sort((a, b) => (b.melhor - a.melhor) || (a.preco - b.preco));

  /* o filtro entra ANTES do corte: o voo procurado pode não estar entre os 40
     mais baratos, e é justamente ele que a pessoa quer achar */
  const filtro = lerFiltro(corpo.filtro);
  const achados = voos.length;
  const escolhidos = filtro ? voos.filter(v => casaVoo(v, filtro)) : voos;

  return json({
    de, para, data,
    adultos: Number(corpo.adultos) || 1,
    criancas: Number(corpo.criancas) || 0,
    filtro,
    achados,
    total: escolhidos.length,
    descartados: brutos.length - voos.length,
    faixa: faixaDePreco(d && d.data && d.data.priceHistory),
    voos: escolhidos.slice(0, 40)
  });
}

export const onRequestGet = () =>
  json({ erro: "Use POST." }, 405);
