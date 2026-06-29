// Compatibility shim: CDP module now uses Advanced Trade REST
// Memory notes: "CDP keys at ~/.cdp/cdp_api_key.json but codebase targets Advanced Trade REST, not CDP"
import { CoinbaseRest } from './coinbase-rest.ts';

type CoinbaseCDPRestOptions = ConstructorParameters<typeof CoinbaseRest>[0];

export class CoinbaseCDPRest extends CoinbaseRest {
  constructor(options: CoinbaseCDPRestOptions = {}) {
    super(options);
  }
}
