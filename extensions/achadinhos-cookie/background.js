// Envio automático: duas vezes por dia, ao abrir o navegador e quando o ML troca a sessão.
importScripts("common.js");

const agendar = () => chrome.alarms.create("enviar", { delayInMinutes: 1, periodInMinutes: 12 * 60 });

chrome.runtime.onInstalled.addListener(agendar);
chrome.runtime.onStartup.addListener(agendar);

chrome.alarms.onAlarm.addListener((alarme) => {
  if (alarme.name === "enviar" || alarme.name === "mudou") void enviarCookie();
});

// Sessão renovada pelo ML: espera um minuto (vários cookies mudam juntos) e manda.
chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
  if (removed || !cookie.domain.includes("mercadolivre") || !["ssid", "nsa_rotok"].includes(cookie.name)) return;
  chrome.alarms.create("mudou", { delayInMinutes: 1 });
});

chrome.runtime.onMessage.addListener((pedido, _remetente, responder) => {
  if (pedido?.tipo === "enviar") {
    enviarCookie().then(responder);
    return true;
  }
  if (pedido?.tipo === "amazon") {
    enviarAmazon(pedido.produto).then(responder);
    return true;
  }
  return false;
});
