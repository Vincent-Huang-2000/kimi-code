import { registerFlagDefinition } from '#/app/flag/flagRegistry';

export const INTENT_ENGINE_FLAG = 'intent_engine';

registerFlagDefinition({
  id: INTENT_ENGINE_FLAG,
  title: 'Intent Engine',
  description: 'Track task requirements and enable one-shot /deep analysis.',
  env: 'KIMI_CODE_EXPERIMENTAL_INTENT_ENGINE',
  default: false,
  surface: 'both',
});
