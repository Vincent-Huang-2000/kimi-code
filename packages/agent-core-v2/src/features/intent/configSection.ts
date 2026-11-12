import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject } from '#/app/config/toml';
import { IntentBudgetSchema } from './intentState';

registerConfigSection('intent', IntentBudgetSchema, {
  collectDiagnostics: (raw) => isPlainObject(raw) && Object.hasOwn(raw, 'max_tokens') ? [{
    domain: 'intent', severity: 'warning',
    message: "[intent] 'max_tokens' is no longer supported; /deep records token usage without a token limit. Remove this key from config.toml.",
  }] : [],
});
