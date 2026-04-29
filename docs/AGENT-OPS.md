# AGENT-OPS — Infraestrutura, Rede e Proxy

Documenta a topologia de rede da infraestrutura de produção (Hostinger VPS +
Gluetun + Mullvad + Tailscale) e o estado atual da implementação de proxy no
código. Claude Code deve ler este arquivo antes de qualquer refatoração em
chamadas HTTP, RPC ou WebSocket.

---

## 1. Topologia de Rede

```
Internet
    │
    ▼
Mullvad VPN (Paraguay / Switzerland exit node)
    │
    ▼
Gluetun container  ←──────────────── todo tráfego Polymarket/Binance/RPC
    │  SOCKS5 em 127.0.0.1:1080
    │
    ▼
Node.js (src/index.js e afins)
    │
    ▼
Tailscale (100.x.x.x)  ←──────────── gestão SSH — bypass de proxy obrigatório
```

O tráfego **não** é roteado via interface de rede global. A interface principal
da VPS vaza diretamente para o IP do Hostinger, que está bloqueado pela
Polymarket. Todo tráfego externo deve sair pelo Gluetun.

---

## 2. Por que `ALL_PROXY` não funciona sozinha

O **Node 20** (fetch nativo) e o **Ethers.js v6** ignoram `ALL_PROXY`,
`HTTPS_PROXY` e `HTTP_PROXY` como variáveis de ambiente do sistema operacional.
Definir essas variáveis no `.env` **não faz as chamadas HTTP passarem pelo proxy
automaticamente**.

A solução implementada no projeto usa duas abordagens:

- **HTTP/fetch**: `setGlobalDispatcher(new ProxyAgent(proxyUrl))` do undici,
  que intercepta o fetch nativo do Node 20 (que usa undici internamente)
- **WebSockets**: `new SocksProxyAgent(proxyUrl)` passado como `agent` na
  instância `WebSocket`

---

## 3. Estado Atual da Implementação de Proxy

### Módulo central: `src/net/proxy.js`

Lê `ALL_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY` do ambiente e expõe:

- `applyGlobalProxyFromEnv()` — configura o dispatcher global do undici
- `wsAgentForUrl(url)` — retorna o agent correto (SOCKS ou HTTPS) para WebSockets

### Chamadas cobertas (proxy funcionando)

| Módulo | Mecanismo |
|---|---|
| `src/data/binance.js` — klines REST | undici global dispatcher (fetch nativo) |
| `src/data/polymarket.js` — Gamma + CLOB REST | undici global dispatcher (fetch nativo) |
| `src/data/chainlink.js` — HTTP fallback RPC | undici global dispatcher (fetch nativo) |
| `src/data/binanceWs.js` — WebSocket spot price | `wsAgentForUrl()` na instância `ws` |
| `src/data/chainlinkWs.js` — WebSocket Chainlink | `wsAgentForUrl()` na instância `ws` |
| `src/data/polymarketLiveWs.js` — WebSocket Polymarket | `wsAgentForUrl()` na instância `ws` |
| `src/trade/executor.js` — CLOB API (ordens, saldo) | undici global dispatcher (fetch nativo) |

O `applyGlobalProxyFromEnv()` é chamado em `src/index.js:52`, antes de qualquer
chamada de rede.

### Lacuna conhecida: RPCs de Polygon via Ethers.js

| Módulo | Problema |
|---|---|
| `src/trade/executor.js:161` | `new JsonRpcProvider(CONFIG.chainlink.polygonRpcUrl)` sem proxy |
| `src/trade/redeemer.js:47` | `new JsonRpcProvider(RPC_URL)` sem proxy |

O `JsonRpcProvider` do Ethers.js v6 usa seu próprio stack HTTP interno que
**não respeita o dispatcher global do undici**. As chamadas RPC de Polygon
desses dois módulos (consulta de nonce, envio de transações, resgate de
posições) saem pelo IP real do Hostinger.

#### Correção necessária (quando for endereçar)

```js
import { SocksProxyAgent } from 'socks-proxy-agent';
import { JsonRpcProvider, FetchRequest } from 'ethers';

const proxyUrl = process.env.ALL_PROXY || process.env.HTTPS_PROXY || '';
const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;

const fetchReq = new FetchRequest(RPC_URL);
if (agent) fetchReq.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
const provider = new JsonRpcProvider(fetchReq);
```

---

## 4. Regras de Anti-Lockout

**Tailscale (`100.x.x.x`) é a âncora de gestão — nunca rotear via proxy.**

O Tailscale fornece acesso SSH independente da VPN Mullvad. Se o proxy SOCKS5
for aplicado ao tráfego do Tailscale, o servidor fica inacessível caso a VPN
caia.

Regra prática: o `socks-proxy-agent` e o `ProxyAgent` do undici só devem ser
instanciados para destinos externos (Polymarket, Binance, Chainlink, RPCs
públicos). Nunca aplicar proxy para:
- Tailscale: `100.x.x.x`
- Localhost: `127.x.x.x`
- Rede interna do Gluetun: `10.x.x.x`

---

## 5. Variável de Ambiente

| Variável | Valor esperado | Observação |
|---|---|---|
| `ALL_PROXY` | `socks5://127.0.0.1:1080` | Lida por `proxy.js` e aplicada via undici |

`proxy.js` também lê `HTTPS_PROXY` e `HTTP_PROXY` como fallback. Documente no
`.env.example` que essas variáveis **não são lidas automaticamente pelo Node 20
ou pelo Ethers.js** — só funcionam porque `proxy.js` as lê manualmente.

---

## 6. Referência: Stack de Infraestrutura

| Componente | Função |
|---|---|
| Hostinger VPS | Servidor de produção |
| Gluetun (Docker) | Container VPN — expõe SOCKS5 em `127.0.0.1:1080` |
| Mullvad VPN | Exit nodes no Paraguai / Suíça (necessário para Polymarket) |
| Tailscale | Acesso SSH de gestão — IP `100.x.x.x` — bypass obrigatório |
| PM2 | Process manager dos agentes Node.js (ver `OPERACOES.md`) |
