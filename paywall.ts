import { errorInfo, logger, maskPhone } from '../utils/logger.js';

/**
 * Cobrança pelo Asaas + controle de acesso pelo número do WhatsApp.
 *
 * - Quem pagou: acesso liberado por ACCESS_DAYS a partir do pagamento.
 * - Quem não pagou: tem FREE_ANALYSES análises grátis; depois recebe o link de pagamento.
 * - O próprio Asaas guarda quem pagou (cliente com externalReference = número), então
 *   reiniciar o servidor não perde os assinantes.
 */

export type Access = 'paid' | 'free' | 'blocked';

export interface Paywall {
  check(phone: string): Promise<Access>;
  /** Marca uma análise grátis como usada. */
  useFree(phone: string): void;
  /** Mensagem com o link de pagamento para esse número. */
  payMessage(phone: string): Promise<string>;
  /** Trata o webhook do Asaas. Devolve o número liberado (se houver). */
  onWebhook(body: unknown): Promise<string | null>;
}

export interface PaywallOptions {
  apiKey: string;
  sandbox: boolean;
  planName: string;
  price: number;
  accessDays: number;
  freeAnalyses: number;
  /** Números que nunca pagam (dono, influenciador). */
  exempt: string[];
  /** Para onde o cliente volta depois de pagar. */
  siteUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DAY = 86_400_000;
const digits = (s: string) => s.replace(/\D/g, '');
const brl = (v: number) => v.toFixed(2).replace('.', ',');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Formas do mesmo número (com e sem o 9º dígito brasileiro). */
function variants(phone: string): string[] {
  const d = digits(phone);
  const out = new Set([d]);
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') out.add(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12) out.add(d.slice(0, 4) + '9' + d.slice(4));
  return [...out];
}

export function createPaywall(opts: PaywallOptions): Paywall {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const base = opts.sandbox ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3';
  const checkoutBase = opts.sandbox ? 'https://sandbox.asaas.com' : 'https://asaas.com';
  const exempt = new Set(opts.exempt.flatMap(variants));

  const paidUntil = new Map<string, number>(); // cache: número -> fim do acesso
  const negative = new Map<string, number>(); // cache curto de "não pagou"
  const freeUsed = new Map<string, number>();
  const expired = new Set<string>(); // já pagou antes, mas venceu
  const checkouts = new Map<string, string>(); // checkoutId -> número
  const openLink = new Map<string, { url: string; until: number }>();

  async function api(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await doFetch(base + path, {
      ...init,
      headers: { access_token: opts.apiKey, 'Content-Type': 'application/json', 'User-Agent': 'sinuca-ai', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* corpo não-JSON */
    }
    if (!res.ok) throw new Error(`Asaas ${init.method ?? 'GET'} ${path.split('?')[0]} falhou (HTTP ${res.status}): ${text.slice(0, 300)}`);
    return isObj(data) ? data : {};
  }

  const list = (d: Record<string, unknown>) => (Array.isArray(d.data) ? d.data.filter(isObj) : []);

  /** Consulta no Asaas até quando esse número tem acesso pago. 0 = não pagou. */
  async function lookupPaidUntil(phone: string): Promise<number> {
    let best = 0;
    for (const v of variants(phone)) {
      const customers = list(await api(`/customers?externalReference=${encodeURIComponent(v)}&limit=10`));
      for (const c of customers) {
        if (typeof c.id !== 'string') continue;
        const payments = list(await api(`/payments?customer=${encodeURIComponent(c.id)}&limit=50`));
        for (const p of payments) {
          if (p.status !== 'RECEIVED' && p.status !== 'CONFIRMED' && p.status !== 'RECEIVED_IN_CASH') continue;
          const when = Date.parse(String(p.paymentDate ?? p.confirmedDate ?? p.clientPaymentDate ?? p.dateCreated ?? ''));
          if (Number.isFinite(when)) best = Math.max(best, when + opts.accessDays * DAY);
        }
      }
    }
    return best;
  }

  function grant(phone: string, until: number) {
    for (const v of variants(phone)) {
      paidUntil.set(v, Math.max(paidUntil.get(v) ?? 0, until));
      negative.delete(v);
      openLink.delete(v);
      expired.delete(v);
    }
  }

  async function createCheckout(phone: string): Promise<string> {
    const key = digits(phone);
    const cached = openLink.get(key);
    if (cached && cached.until > now()) return cached.url;
    const site = opts.siteUrl.replace(/\/$/, '');
    const data = await api('/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        billingTypes: ['PIX', 'CREDIT_CARD'],
        chargeTypes: ['DETACHED'],
        minutesToExpire: 1440,
        externalReference: key,
        callback: { successUrl: `${site}/?pago=1`, cancelUrl: `${site}/`, expiredUrl: `${site}/` },
        items: [{ name: opts.planName, description: `${opts.accessDays} dias de acesso`, quantity: 1, value: opts.price }],
      }),
    });
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id) throw new Error('Asaas não devolveu o id do checkout.');
    checkouts.set(id, key);
    const url = typeof data.link === 'string' && data.link.startsWith('https://') ? data.link : `${checkoutBase}/checkoutSession/show?id=${encodeURIComponent(id)}`;
    openLink.set(key, { url, until: now() + 23 * 3600_000 });
    logger.info('Link de pagamento criado', { to: maskPhone(key) });
    return url;
  }

  return {
    async check(phone) {
      const vs = variants(phone);
      if (vs.some((v) => exempt.has(v))) return 'paid';
      const t = now();
      if (vs.some((v) => (paidUntil.get(v) ?? 0) > t)) return 'paid';
      const neg = Math.max(...vs.map((v) => negative.get(v) ?? 0));
      if (neg <= t) {
        try {
          const until = await lookupPaidUntil(phone);
          if (until > t) {
            grant(phone, until);
            return 'paid';
          }
          for (const v of vs) {
            negative.set(v, t + 60_000);
            if (until > 0) expired.add(v);
          }
        } catch (err) {
          logger.error('Falha ao consultar pagamento no Asaas', errorInfo(err));
        }
      }
      const used = Math.max(...vs.map((v) => freeUsed.get(v) ?? 0));
      return used < opts.freeAnalyses ? 'free' : 'blocked';
    },

    useFree(phone) {
      for (const v of variants(phone)) freeUsed.set(v, (freeUsed.get(v) ?? 0) + 1);
    },

    async payMessage(phone) {
      const vs = variants(phone);
      const reason = vs.some((v) => expired.has(v)) ? 'expired' : vs.some((v) => (freeUsed.get(v) ?? 0) > 0) ? 'used-free' : 'first';
      const head =
        reason === 'used-free'
          ? '🎱 Essa foi sua análise grátis! Curtiu? Pra continuar recebendo as jogadas, libera seu acesso:'
          : reason === 'expired'
            ? '⏰ Seu acesso venceu. Pra continuar recebendo as jogadas, renova aqui:'
            : '🎱 Pra receber as jogadas, libera seu acesso:';
      try {
        const url = await createCheckout(phone);
        return `${head}\n\n👉 ${url}\n\n${opts.planName}: R$ ${brl(opts.price)} por ${opts.accessDays} dias, no Pix ou cartão. Assim que pagar, eu te aviso aqui e já pode mandar a foto da mesa.`;
      } catch (err) {
        logger.error('Falha ao criar link de pagamento', errorInfo(err));
        return `${head}\n\nTô com problema pra gerar o link agora. Tenta de novo em alguns minutos. 🙏`;
      }
    },

    async onWebhook(body) {
      if (!isObj(body)) return null;
      const event = typeof body.event === 'string' ? body.event : '';
      logger.info('Webhook do Asaas', { event });
      if (!['CHECKOUT_PAID', 'PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED_IN_CASH'].includes(event)) return null;

      let phone: string | undefined;
      let customer: string | undefined;
      if (isObj(body.checkout)) {
        const co = body.checkout;
        phone = (typeof co.id === 'string' && checkouts.get(co.id)) || (typeof co.externalReference === 'string' ? digits(co.externalReference) : undefined);
        customer = typeof co.customer === 'string' ? co.customer : undefined;
      }
      if (isObj(body.payment)) {
        const p = body.payment;
        customer ??= typeof p.customer === 'string' ? p.customer : undefined;
        if (!phone && typeof p.checkoutSession === 'string') phone = checkouts.get(p.checkoutSession);
        if (!phone && typeof p.externalReference === 'string' && /^\d{10,15}$/.test(digits(p.externalReference))) phone = digits(p.externalReference);
      }
      if (!phone && customer) {
        try {
          const c = await api(`/customers/${encodeURIComponent(customer)}`);
          if (typeof c.externalReference === 'string' && /^\d{10,15}$/.test(c.externalReference)) phone = c.externalReference;
        } catch (err) {
          logger.warn('Não consegui ler o cliente do Asaas', errorInfo(err));
        }
      }
      if (!phone) {
        logger.warn('Pagamento sem número associado', { event, keys: Object.keys(body).join(',') });
        return null;
      }
      // Grava o número no cliente do Asaas: é assim que o acesso sobrevive a reinícios.
      if (customer) {
        try {
          await api(`/customers/${encodeURIComponent(customer)}`, { method: 'POST', body: JSON.stringify({ externalReference: phone }) });
        } catch (err) {
          logger.warn('Não consegui gravar o número no cliente do Asaas', errorInfo(err));
        }
      }
      const already = (paidUntil.get(phone) ?? 0) > now();
      grant(phone, now() + opts.accessDays * DAY);
      logger.info('Acesso liberado', { to: maskPhone(phone), event });
      return already ? null : phone;
    },
  };
}

export const MSG_PAID = '✅ Pagamento confirmado, acesso liberado! 🎱 Manda a foto da mesa (de cima, mesa inteira) e depois um áudio contando a situação.';
export const MSG_FREE_HINT =
  'Fala! 🎱 Sou o treinador de sinuca. Você tem 1 análise grátis: manda uma foto da mesa (de cima, mesa inteira) e depois um áudio 🎤 ou texto contando a situação, que eu te passo as melhores jogadas.';
