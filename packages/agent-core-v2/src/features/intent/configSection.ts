import { registerConfigSection } from '#/app/config/configSectionContributions';
import { IntentBudgetSchema } from './intentState';

registerConfigSection('intent', IntentBudgetSchema);
