import { z } from 'zod';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const required = z.string('is required').min(1, { error: 'is required', abort: true });

const origin = required.transform((value, ctx) => {
  const url = URL.parse(value);
  if (url && /^https?:$/.test(url.protocol) && url.href === `${url.origin}/`) return url.origin;
  ctx.addIssue('must be an http(s) origin without path, query or credentials');
  return z.NEVER;
});

const schema = z.object({
  OWNER_PASSWORD: required,
  PUBLIC_URL: origin,
  ADMIN_URL: origin,
  DATA: z.string().min(1, 'must not be empty').default('./data'),
});

export type Config = z.output<typeof schema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`);
  throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
}
