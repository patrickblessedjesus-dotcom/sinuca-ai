type Level = 'info' | 'warn' | 'error';

/** Mostra só os 4 últimos dígitos de um telefone. */
export function maskPhone(phone: string | undefined): string {
  if (!phone) return '(desconhecido)';
  const digits = phone.replace(/\D/g, '');
  return digits.length <= 4 ? '****' : `***${digits.slice(-4)}`;
}

function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(meta ?? {}) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};

/** Extrai uma descrição segura de um erro, sem stack nem dados de requisição. */
export function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = { error: err.name, message: err.message.slice(0, 300) };
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') out.status = status;
    return out;
  }
  return { error: String(err).slice(0, 300) };
}
