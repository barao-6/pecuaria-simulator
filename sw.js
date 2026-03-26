// CORREÇÃO:
if (isNetworkOnlyApiRequest(url)) {
  // Retorna o fetch diretamente. Se estiver offline, a Promise será rejeitada,
  // permitindo que o Firebase ative seu cache offline nativo.
  event.respondWith(fetch(request));
  return;
}
