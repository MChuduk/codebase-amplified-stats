import type { Provider, ProviderId } from '../common';
import { github } from './github';

const PROVIDERS: Record<ProviderId, Provider> = { github };

/** Total by construction: `ProviderId` and this map are declared together. */
export function providerFor(id: ProviderId): Provider {
  return PROVIDERS[id];
}
